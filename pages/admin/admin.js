// pages/admin/admin.js
// 管理后台（v1.7.1：统一审核流 + 被举报帖也进队列 + 处罚必带原因）。
//
// 【三个 Tab = 三类待办】
//   【内容审核】两类帖子会出现在这里：
//               ① status === 'auditing'：首帖 / 有违规记录 / 举报满 5 人被打码的帖子；
//               ② 【v1.7.1】不足 5 人举报、但还有 pending 举报的帖子（status 仍是 active / ended）。
//               两者的区别就在按钮文案：①【通过】【下架（选原因）】；②【忽略举报】【下架（选原因）】。
//               卡片顶部直接给 auditReason 标签（按类型分色），云端拼好文案，前端不拼字符串。
//   【学号申诉】按学号精确搜索 → 记警告 / 封禁 / 强制解绑（前两个必选原因）。
//   【系统公告】发布全体公告（写 announcements，所有用户消息中心可见）。
//
// 【为什么所有数据都走云函数】
//   posts / reports / users 三个集合对客户端「所有用户不可读写」，
//   所以列表、搜索、处罚全部调用 cloudfunctions/admin（action: getAuditQueue / approve / reject / searchUser ...），
//   前端只负责渲染。页面里的「是不是管理员」只是体验层：改包把页面调出来，云函数第一行也会回 FORBIDDEN。
//
// 交互约定：
//   · 进页面 / 下拉刷新 -> getAuditQueue（云端分页，默认一次只回最新 20 条）
//   · 【通过】：二次确认 -> action 'approve'（帖子恢复上线 + 该帖举报全部结案 + 通知作者）
//   · 【忽略举报】：被举报但仍在展示的帖子 -> 二次确认 -> 同一个 action 'approve'
//                   （云端检测到帖子不是 auditing 时只清举报记录，不改状态、不通知作者）
//   · 【下架】：先 ActionSheet 选原因 -> 再二次确认 -> action 'reject'（下架 + 警告 +1 + 通知作者）
//   · 记警告 / 封禁：先 ActionSheet 选原因（必选）-> 再二次确认 -> 原因写进日志与站内通知

const store = require('../../utils/store');
const constants = require('../../utils/constants');

const ROLE_MAP = constants.ROLE_MAP;
const CATEGORY_MAP = constants.CATEGORY_MAP;
const WARNING_BAN_THRESHOLD = constants.WARNING_BAN_THRESHOLD;

// 下架原因选项（写进 posts.deleteReason + 站内通知，必须让作者看得懂）
// 不用输入框：后台是在手机上操作，键盘输入原因很容易漏字或写得太随意
const AUDIT_REJECT_REASONS = [
  '含违禁词或违规内容',
  '广告 / 引流信息',
  '虚假或误导性信息',
  '涉及敏感内容',
  '不符合校园互助定位'
];

// 处罚原因选项（v1.7.1）：记警告 / 封禁都必须选一个原因，
// 原因会写进 admin_logs，并通过站内通知明确告知被封禁 / 警告的用户（合规追溯）。
const USER_PUNISH_REASONS = [
  '违规发帖',
  '恶意骚扰',
  '诈骗嫌疑',
  '虚假信息',
  '其他'
];

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

Page({
  data: {
    tabs: constants.ADMIN_TABS,
    // v1.7.0：默认落在「内容审核」—— 后台的第一件事永远是清待审队列
    activeTab: 'audit',

    // ---- 内容审核（待办队列，分页）----
    auditLoading: false,
    auditLoaded: false,   // 首次加载完成才显示「队列已清空」，避免一闪而过的空状态
    auditPosts: [],
    auditError: '',
    auditWorkingId: '',   // 正在处理中的帖子 id（按钮置灰，防重复提交）
    auditHasMore: false,  // 云端还有更多待办（一页 20 条，处理完刷新看下一批）
    auditPendingTotal: 0, // 云端当前待办总数（分页前）
    auditPageSize: 20,

    // ---- 学号申诉 ----
    studentIdInput: '',
    userLoading: false,
    userSearched: false,
    users: [],
    userError: '',

    // ---- 系统公告 ----
    announceTitle: '',
    announceContent: '',
    announceLoading: false,
    announceError: '',
    announceTitleMax: constants.ANNOUNCEMENT_TITLE_MAX,
    announceContentMax: constants.ANNOUNCEMENT_CONTENT_MAX
  },

  // onShow 而不是 onLoad：从详情页预览回来、或从别的 Tab 切回来时也要最新队列
  onShow: function () {
    this.guardAndLoad();
  },

  onPullDownRefresh: async function () {
    try {
      if (this.data.activeTab === 'audit') {
        await this.loadAuditQueue();
      } else if (this.data.activeTab === 'appeal' && (this.data.studentIdInput || '').trim()) {
        await this.searchUser();
      }
      // 系统公告 Tab 是表单，下拉只清错误提示，不重发上次的内容
      if (this.data.activeTab === 'announce') {
        this.setData({ announceError: '' });
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

    if (this.data.activeTab === 'audit') {
      await this.loadAuditQueue();
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
    // 纯内存切换（与大厅 Tab 同一约定）：只有还没加载过的 Tab 才打一次接口
    this.setData({ activeTab: tab });
    if (tab === 'audit' && !this.data.auditLoaded) {
      this.loadAuditQueue();
    }
  },

  /* ---------------- 内容审核（唯一待办队列） ---------------- */

  /**
   * 拉取审核队列（v1.7.1）
   *   云端两类待办合并后分页，默认只回最新 20 条：
   *     ① status === 'auditing' 的帖子；
   *     ② 还有 pending 举报但帖子仍是 active / ended 的（不足 5 人举报）。
   *   云端已批量联查 reports / users 并拼好 auditReason，前端不再自己算原因。
   */
  loadAuditQueue: async function () {
    if (this.data.auditLoading) return;
    this.setData({ auditLoading: true, auditError: '' });

    try {
      const result = await store.fetchAdminAuditQueue();
      const list = result.list.map(function (item) {
        const tags = Array.isArray(item.auditTags) ? item.auditTags : [];
        // isAuditing=false = 被举报但还在正常展示的帖子 -> 主按钮叫【忽略举报】
        const isAuditing = item.isAuditing !== false; // 老版本云端没这个字段时按「审中」处理
        return {
          postId: item.postId || '',
          reportId: item.reportId || '',
          title: item.title || '（无标题）',
          content: item.content || '',
          categoryText: CATEGORY_MAP[item.category] || '未分类',
          tags: Array.isArray(item.tags) ? item.tags : [],
          authorName: item.authorName || '未设置昵称',
          // 校区：审核时用来看内容与学生身份是否自洽（非敏感值）
          authorCampus: item.authorCampus || '',
          studentIdMasked: item.authorStudentIdMasked || '',
          warningCount: Number(item.authorWarningCount) || 0,
          reportCount: Number(item.reportCount) || 0,
          latestReportReason: item.latestReportReason || '',
          // auditReason：云端拼好的完整文案（多条件逗号连接），再拆成 tags 分色展示
          auditReason: item.auditReason || '',
          auditTags: tags.length ? tags : [{ type: 'other', text: '人工复核' }],
          isAuditing: isAuditing,
          // 按钮文案：审中 -> 【通过】；被举报线上帖 -> 【忽略举报】
          approveText: isAuditing ? '通过' : '忽略举报',
          createTime: formatTime(item.createTime)
        };
      });

      this.setData({
        auditPosts: list,
        auditLoading: false,
        auditLoaded: true,
        auditHasMore: !!result.hasMore,
        auditPendingTotal: Number(result.pendingTotal) || list.length,
        auditPageSize: Number(result.pageSize) || 20
      });
    } catch (err) {
      console.error('[admin] 审核队列拉取失败：', err);
      const message = err && err.code === 'FUNCTION_CALL_FAILED'
        ? 'admin 云函数未部署，请先在开发者工具上传并部署'
        : ((err && err.message) || '审核队列拉取失败，请下拉重试');
      this.setData({
        auditLoading: false,
        auditLoaded: true,
        auditError: message
      });
    }
  },

  /**
   * 点标题预览帖子全文
   * 带上 admin=1：详情页原本会拦截「审查中（auditing）」的帖子，
   * 管理员预览通道会先校验云端 role === 'admin' 才放行，且预览模式下不加热度、不显示报名/举报按钮。
   */
  goPostDetail: function (e) {
    const postId = e.currentTarget.dataset.postId;
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

  // 【通过 / 忽略举报】
  //   审中帖：通过 = 直接上线（status = 'active'），云端把该帖举报一并结案并通知作者；
  //   被举报的线上帖：忽略举报 = 只清举报记录，帖子不动、不通知作者。
  onAuditApproveTap: function (e) {
    const dataset = e.currentTarget.dataset;
    this.confirmAuditApprove(dataset.postId, dataset.reportId, dataset.title || '', dataset.isAuditing !== false);
  },

  confirmAuditApprove: function (postId, reportId, title, isAuditing) {
    if (!postId) {
      wx.showToast({ title: '缺少帖子信息', icon: 'none' });
      return;
    }

    const that = this;
    if (!isAuditing) {
      // 被举报但还在展示：文案必须说清「帖子不会被下架、作者不会收到通知」
      wx.showModal({
        title: '忽略举报',
        content: '「' + (title || '该帖子') + '」目前仍在正常展示。忽略后该帖的举报记录会被清理，' +
          '帖子保持上线、不会通知发帖人。确定忽略吗？',
        confirmText: '忽略举报',
        success: function (res) {
          if (!res.confirm) return;
          that.runAuditAction('approve', postId, reportId, '');
        }
      });
      return;
    }

    wx.showModal({
      title: '审核通过',
      content: '「' + (title || '该帖子') + '」将立即在大厅展示，并通知发帖人。该帖子名下的待处理举报会一并结案。确定吗？',
      confirmText: '通过上线',
      success: function (res) {
        if (!res.confirm) return;
        that.runAuditAction('approve', postId, reportId, '');
      }
    });
  },

  // 【下架（选原因）】：先选原因，再二次确认，原因是必须给作者看的
  onAuditRejectTap: function (e) {
    const dataset = e.currentTarget.dataset;
    this.chooseRejectReason(dataset.postId, dataset.reportId, dataset.title || '');
  },

  chooseRejectReason: function (postId, reportId, title) {
    if (!postId) {
      wx.showToast({ title: '缺少帖子信息', icon: 'none' });
      return;
    }

    const that = this;
    wx.showActionSheet({
      itemList: AUDIT_REJECT_REASONS,
      success: function (res) {
        const reason = AUDIT_REJECT_REASONS[res.tapIndex] || '';
        that.confirmAuditReject(postId, reportId, title, reason);
      },
      fail: function () {
        // 取消选择：什么都不做（不弹错误提示，避免误以为是失败）
      }
    });
  },

  confirmAuditReject: function (postId, reportId, title, reason) {
    const that = this;
    wx.showModal({
      title: '确认下架',
      content: '「' + (title || '该帖子') + '」将以「' + reason + '」为原因下架，并给发帖人记一次违规警告' +
        '（累计满 ' + WARNING_BAN_THRESHOLD + ' 次自动封禁）。确定吗？',
      confirmText: '确认下架',
      confirmColor: '#e53935',
      success: function (res) {
        if (!res.confirm) return;
        that.runAuditAction('reject', postId, reportId, reason);
      }
    });
  },

  /**
   * 执行审核动作
   * @param {'approve'|'reject'} action
   */
  runAuditAction: async function (action, postId, reportId, reason) {
    if (this.data.auditWorkingId) return;
    this.setData({ auditWorkingId: postId });

    wx.showLoading({ title: action === 'approve' ? '处理中...' : '下架中...', mask: true });
    try {
      let result = null;
      if (action === 'approve') {
        result = await store.adminApprovePost(postId, reportId);
      } else {
        result = await store.adminRejectPost(postId, reportId, reason);
      }

      wx.hideLoading();
      this.setData({ auditWorkingId: '' });

      // toast 直接说结果，管理员不用猜「警告记上了没有」
      let toast = '已下架';
      if (action === 'approve') {
        toast = (result && result.ignored) ? '已忽略举报' : '已通过，帖子已上线';
      } else if (result && result.banned) {
        toast = '已下架，作者已封禁';
      } else if (result && result.warningCount) {
        toast = '已下架，作者警告 ' + result.warningCount + '/' + WARNING_BAN_THRESHOLD;
      }
      wx.showToast({ title: toast, icon: 'none' });

      await this.loadAuditQueue();
    } catch (err) {
      wx.hideLoading();
      console.error('[admin] 审核处理失败：', err);
      this.setData({ auditWorkingId: '' });
      wx.showToast({
        title: (err && err.message) || '处理失败，请稍后重试',
        icon: 'none'
      });
    }
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
  },

  /* ---------------- 用户处置：记警告 / 封禁 ----------------
   * 【v1.7.1 合规追溯】两个动作都必须先选原因（wx.showActionSheet 预设项）：
   *   原因会传给云端，写进 admin_logs，并通过站内通知明确告知该用户（“为什么被罚”）。*/

  /**
   * 弹预设处罚原因选择
   * @return {Promise<string|null>} 选中的原因；取消（或未选）返回 null
   */
  choosePunishReason: function () {
    return new Promise(function (resolve) {
      wx.showActionSheet({
        itemList: USER_PUNISH_REASONS,
        success: function (res) {
          resolve(USER_PUNISH_REASONS[res.tapIndex] || '');
        },
        fail: function () {
          // 取消选择：什么都不做（不弹错误提示，避免误以为是失败）
          resolve(null);
        }
      });
    });
  },

  onWarningTap: async function (e) {
    const targetOpenid = e.currentTarget.dataset.openid;
    if (!targetOpenid) {
      wx.showToast({ title: '缺少目标用户', icon: 'none' });
      return;
    }

    const reason = await this.choosePunishReason();
    if (!reason) return; // 没选原因 = 取消，不执行任何处罚

    const that = this;
    wx.showModal({
      title: '记一次违规警告',
      content: '原因：' + reason + '。该账号将收到一条写明原因的站内警告通知；累计满 ' +
        WARNING_BAN_THRESHOLD + ' 次会自动封禁。确定吗？',
      confirmText: '记警告',
      confirmColor: '#e53935',
      success: function (res) {
        if (!res.confirm) return;

        wx.showLoading({ title: '处理中...' });
        store.adminAddWarning(targetOpenid, reason)
          .then(function (result) {
            wx.hideLoading();
            const count = Number(result && result.warningCount) || 0;
            wx.showToast({
              title: (result && result.banned) ? '已封禁（警告满额）' : ('已记录，当前 ' + count + ' 次'),
              icon: 'none'
            });
            return that.searchUser();
          })
          .catch(function (err) {
            wx.hideLoading();
            console.error('[admin] 记警告失败：', err);
            wx.showToast({
              title: (err && err.message) || '操作失败，请稍后重试',
              icon: 'none'
            });
          });
      }
    });
  },

  onBanTap: async function (e) {
    const targetOpenid = e.currentTarget.dataset.openid;
    if (!targetOpenid) {
      wx.showToast({ title: '缺少目标用户', icon: 'none' });
      return;
    }

    const reason = await this.choosePunishReason();
    if (!reason) return; // 没选原因 = 取消，不执行任何处罚

    const that = this;
    wx.showModal({
      title: '封禁账号',
      content: '原因：' + reason + '。封禁后该账号无法发布、申请、评价、举报，也不能再登录' +
        '（openid 会进黑名单）。封禁为不可自助解除，请确认已掌握违规证据。',
      confirmText: '确认封禁',
      confirmColor: '#e53935',
      success: function (res) {
        if (!res.confirm) return;

        wx.showLoading({ title: '处理中...' });
        store.adminBanUser(targetOpenid, reason)
          .then(function () {
            wx.hideLoading();
            wx.showToast({ title: '已封禁', icon: 'none' });
            return that.searchUser();
          })
          .catch(function (err) {
            wx.hideLoading();
            console.error('[admin] 封禁失败：', err);
            wx.showToast({
              title: (err && err.message) || '封禁失败，请稍后重试',
              icon: 'none'
            });
          });
      }
    });
  },

  /* ---------------- 系统公告 ---------------- */

  onAnnounceTitleInput: function (e) {
    this.setData({ announceTitle: e.detail.value || '' });
  },

  onAnnounceContentInput: function (e) {
    this.setData({ announceContent: e.detail.value || '' });
  },

  /**
   * 发布公告：写 announcements（所有人共用一条），不进个人 messages。
   * 用户侧的「新公告」提示由本地 lastReadMessageTime 判定，所以这里不需要给每个人写消息。
   */
  onPublishAnnouncementTap: function () {
    const title = (this.data.announceTitle || '').trim();
    const content = (this.data.announceContent || '').trim();

    if (!title) {
      wx.showToast({ title: '请填写公告标题', icon: 'none' });
      return;
    }
    if (!content) {
      wx.showToast({ title: '请填写公告内容', icon: 'none' });
      return;
    }

    const that = this;
    wx.showModal({
      title: '发布系统公告',
      content: '发布后所有用户都会在「消息中心」看到这条公告，确定发布吗？',
      confirmText: '发布',
      success: function (res) {
        if (!res.confirm) return;
        that.publishAnnouncement(title, content);
      }
    });
  },

  publishAnnouncement: async function (title, content) {
    if (this.data.announceLoading) return;
    this.setData({ announceLoading: true, announceError: '' });

    try {
      await store.adminPublishAnnouncement({ title: title, content: content });
      // 发布成功：清空表单，避免手滑重复发一条一样的
      this.setData({
        announceTitle: '',
        announceContent: '',
        announceLoading: false
      });
      wx.showToast({ title: '公告已发布', icon: 'none' });
    } catch (err) {
      console.error('[admin] 公告发布失败：', err);
      const message = err && err.code === 'FUNCTION_CALL_FAILED'
        ? 'admin 云函数未部署，请先在开发者工具上传并部署'
        : ((err && err.message) || '公告发布失败，请稍后重试');
      this.setData({ announceLoading: false, announceError: message });
    }
  }
});
