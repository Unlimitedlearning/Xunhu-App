// pages/admin/admin.js
// 管理后台（v1.2.0）：举报审查 + 学号申诉。
//
// 【为什么所有数据都走云函数】
//   reports 与 users 两个集合权限是「所有用户不可读写」，客户端直接 get 必然 -502003。
//   所以列表 / 搜索 / 处罚全部调用 cloudfunctions/admin（action: getReports / ignore /
//   violate / searchUser / unbind），前端只负责渲染。
//   前端这里的「是不是管理员」只是体验层：改包把页面调出来，云函数第一行也会回 FORBIDDEN。
//
// 交互约定：
//   · 进页面 / 下拉刷新 -> getReports
//   · Tab 切换纯内存（不请求），避免无意义调用
//   · 忽略 / 确认违规 / 强制解绑 都是破坏性操作，一律二次确认

const store = require('../../utils/store');
const constants = require('../../utils/constants');

const POST_STATUS_MAP = constants.POST_STATUS_MAP;
const ROLE_MAP = constants.ROLE_MAP;

function pad(value) {
  return value < 10 ? '0' + value : '' + value;
}

// 时间戳 -> YYYY-MM-DD HH:mm（后台要精确到分钟，方便对日志）
function formatTime(timestamp) {
  const value = Number(timestamp) || 0;
  if (!value) return '';
  const date = new Date(value);
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function postStatusText(status, exists) {
  if (!exists) return '帖子已删除';
  return POST_STATUS_MAP[status] || '状态未知';
}

Page({
  data: {
    tabs: constants.ADMIN_TABS,
    activeTab: 'reports',

    // ---- 举报审查 ----
    reportsLoading: false,
    reportsLoaded: false,   // 首次加载完成才显示「暂无举报」，避免一闪而过的空状态
    reports: [],
    reportsError: '',

    // ---- 学号申诉 ----
    studentIdInput: '',
    userLoading: false,
    userSearched: false,
    users: [],
    userError: ''
  },

  // onShow 而不是 onLoad：从详情页改完帖子状态返回时也要最新列表
  onShow: function () {
    this.guardAndLoad();
  },

  onPullDownRefresh: async function () {
    try {
      if (this.data.activeTab === 'reports') {
        await this.loadReports();
      } else if ((this.data.studentIdInput || '').trim()) {
        await this.searchUser();
      }
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  /**
   * 进入前确认「已登录 + 是管理员」
   * 直接用深链接 / 编译模式打开本页时内存里可能还没有资料，所以先 syncProfile 一次
   */
  guardAndLoad: async function () {
    if (!store.isLoggedIn()) {
      this.deny('请先登录后再进入管理后台');
      return;
    }

    // 每次都从云端刷一次资料：控制台刚把 role 改成 admin 时，不用重登也能进得来
    try {
      await store.syncProfile();
    } catch (err) {
      console.error('[admin] 资料同步失败：', err);
    }

    if (!store.isAdmin()) {
      this.deny('当前账号没有管理权限');
      return;
    }

    if (this.data.activeTab === 'reports') {
      await this.loadReports();
    }
  },

  deny: function (message) {
    wx.showModal({
      title: '无法进入管理后台',
      content: message,
      showCancel: false,
      confirmText: '返回',
      success: function () {
        wx.navigateBack({
          fail: function () {
            // 编译模式直接进本页时没有上一页，退回「我的」
            wx.switchTab({ url: '/pages/profile/profile' });
          }
        });
      }
    });
  },

  onTabChange: function (e) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab || tab === this.data.activeTab) return;
    // 纯内存切换，不发请求（与大厅 Tab 同一约定）
    this.setData({ activeTab: tab });
  },

  /* ---------------- 举报审查 ---------------- */

  loadReports: async function () {
    if (this.data.reportsLoading) return;
    this.setData({ reportsLoading: true, reportsError: '' });

    try {
      const result = await store.fetchAdminReports();
      const list = result.list.map(function (item) {
        const exists = item.postExists !== false;
        return {
          reportId: item.reportId || '',
          postId: item.postId || '',
          title: item.postTitle || '（无标题）',
          reason: item.reason || '未填写',
          desc: item.desc || '',
          // 举报人已由云端脱敏（前 4 + 后 4），仅用于区分「同一人反复举报」
          reporter: item.reporterOpenid || '',
          authorName: item.postAuthorName || '',
          statusText: postStatusText(item.postStatus, exists),
          isAuditing: item.postStatus === 'auditing',
          isDeleted: !exists,
          weight: Number(item.postWeight) || 0,
          createTime: formatTime(item.createTime)
        };
      });

      this.setData({
        reports: list,
        reportsLoading: false,
        reportsLoaded: true
      });
    } catch (err) {
      console.error('[admin] 举报列表拉取失败：', err);
      const message = err && err.code === 'FUNCTION_CALL_FAILED'
        ? 'admin 云函数未部署，请先在开发者工具上传并部署'
        : ((err && err.message) || '举报列表拉取失败，请下拉重试');
      this.setData({
        reportsLoading: false,
        reportsLoaded: true,
        reportsError: message
      });
    }
  },

  /**
   * 点标题查看帖子详情（审核用）
   * 带上 admin=1：详情页原本会拦截「审查中（auditing）」的帖子，
   * 管理员预览通道会先校验云端 role === 'admin' 才放行，且预览模式下不加热度、不显示报名/举报按钮。
   */
  goPostDetail: function (e) {
    const dataset = e.currentTarget.dataset;
    const postId = dataset.postId;

    if (dataset.deleted) {
      wx.showToast({ title: '该帖子已被删除', icon: 'none' });
      return;
    }
    if (!postId) {
      wx.showToast({ title: '缺少帖子信息', icon: 'none' });
      return;
    }

    wx.navigateTo({
      url: '/pages/detail/detail?id=' + postId + '&admin=1',
      fail: function (err) {
        console.error('[admin] 打开帖子详情失败：', err);
        wx.showToast({ title: '打开失败，请稍后重试', icon: 'none' });
      }
    });
  },

  onIgnoreTap: function (e) {
    const dataset = e.currentTarget.dataset;
    this.handleReport('ignore', dataset.reportId, dataset.postId);
  },

  onViolateTap: function (e) {
    const dataset = e.currentTarget.dataset;
    this.handleReport('violate', dataset.reportId, dataset.postId);
  },

  /**
   * 处理一条举报
   * @param {string} action 'ignore' | 'violate'
   */
  handleReport: function (action, reportId, postId) {
    if (!reportId) {
      wx.showToast({ title: '缺少举报记录', icon: 'none' });
      return;
    }

    const that = this;
    const isViolate = action === 'violate';

    wx.showModal({
      title: isViolate ? '确认违规' : '忽略举报',
      content: isViolate
        ? '确认后帖子将被下架审查（帖子权重 +2），并给发帖人记一次违规警告；警告满 2 次将自动封禁账号。确定吗？'
        : '忽略 = 判定该帖子没有违规：帖子权重 -1（最低 0）；若它正因自动审查处于「审核中」，会立刻恢复为「进行中」。确定吗？',
      confirmText: isViolate ? '确认违规' : '忽略',
      confirmColor: isViolate ? '#e53935' : '#07c160',
      success: function (res) {
        if (!res.confirm) return;

        wx.showLoading({ title: '处理中...' });
        store.adminHandleReport(action, { reportId: reportId, postId: postId })
          .then(function (result) {
            wx.hideLoading();
            // 忽略后帖子可能已被恢复上线，用云端返回值提示，避免管理员误以为没生效
            const restored = !!(result && result.restored);
            wx.showToast({
              title: restored ? '已忽略，帖子已恢复' : '已处理',
              icon: 'none'
            });
            return that.loadReports();
          })
          .catch(function (err) {
            wx.hideLoading();
            console.error('[admin] 举报处理失败：', err);
            wx.showToast({
              title: (err && err.message) || '处理失败，请稍后重试',
              icon: 'none'
            });
          });
      }
    });
  },

  /* ---------------- 学号申诉 ---------------- */

  onStudentIdInput: function (e) {
    this.setData({ studentIdInput: e.detail.value || '' });
  },

  onSearchTap: function () {
    this.searchUser();
  },

  searchUser: async function () {
    const studentId = (this.data.studentIdInput || '').trim();
    if (!studentId) {
      wx.showToast({ title: '请输入要查询的学号', icon: 'none' });
      return;
    }
    if (this.data.userLoading) return;

    this.setData({ userLoading: true, userError: '', userSearched: false });

    try {
      const result = await store.adminSearchUser(studentId);
      const users = result.list.map(function (item) {
        const role = String(item.role || 'user').toLowerCase();
        return {
          openid: item.openid || '',
          nickname: item.nickname || '未设置昵称',
          // 学号由云端脱敏（31****1234）：后台不需要完整学号，也不展示联系方式
          studentIdMasked: item.studentIdMasked || '',
          role: role,
          roleText: ROLE_MAP[role] || '普通用户',
          warningCount: Number(item.warningCount) || 0,
          updateTime: formatTime(item.updateTime),
          hasOpenid: !!item.openid
        };
      });

      this.setData({
        users: users,
        userLoading: false,
        userSearched: true
      });
    } catch (err) {
      console.error('[admin] 学号查询失败：', err);
      const message = err && err.code === 'FUNCTION_CALL_FAILED'
        ? 'admin 云函数未部署，请先在开发者工具上传并部署'
        : ((err && err.message) || '查询失败，请稍后重试');
      this.setData({
        users: [],
        userLoading: false,
        userSearched: true,
        userError: message
      });
    }
  },

  onUnbindTap: function (e) {
    const targetOpenid = e.currentTarget.dataset.openid;
    if (!targetOpenid) {
      wx.showToast({ title: '缺少目标用户', icon: 'none' });
      return;
    }

    const that = this;
    wx.showModal({
      title: '强制解绑学号',
      content: '解绑后该账号的学号会被清空，用户必须重新绑定学号才能发布 / 申请。确定执行吗？',
      confirmText: '强制解绑',
      confirmColor: '#e53935',
      success: function (res) {
        if (!res.confirm) return;

        wx.showLoading({ title: '处理中...' });
        store.adminUnbind(targetOpenid)
          .then(function () {
            wx.hideLoading();
            wx.showToast({ title: '已解绑', icon: 'none' });
            return that.searchUser();
          })
          .catch(function (err) {
            wx.hideLoading();
            console.error('[admin] 解绑失败：', err);
            wx.showToast({
              title: (err && err.message) || '解绑失败，请稍后重试',
              icon: 'none'
            });
          });
      }
    });
  }
});
