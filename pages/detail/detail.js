// pages/detail/detail.js
// 详情页：读取帖子完整内容，处理「申请加入」与「举报」
// 数据源：云数据库（经 utils/store 的缓存层）

const store = require("../../utils/store");
const constants = require("../../utils/constants");

const CATEGORY_MAP = constants.CATEGORY_MAP;
const POST_STATUS_MAP = constants.POST_STATUS_MAP;
const REPORT_CATEGORIES = constants.REPORT_CATEGORIES;
const AUDITING_BLOCK_MESSAGE = constants.AUDITING_BLOCK_MESSAGE;

// 退回大厅（detail 可能是分享直达打开，栈里没上一页，统一 switchTab 回大厅）
function backToHall(delay) {
  setTimeout(function () {
    wx.switchTab({ url: '/pages/index/index' });
  }, delay || 1200);
}

Page({
  data: {
    post: null,
    category: '',
    categoryKey: '',
    categoryText: '',
    statusText: '',
    statusKey: '',
    isOwner: false,
    hasApplied: false,
    isEnded: false,
    appliedStatus: '',
    appliedText: '',
    notFound: false
  },

  onLoad: async function (options) {
    const id = (options && options.id) || '';

    // 云数据预热（幂等，首次会拉 openid + posts + applications）
    try {
      await store.init();
    } catch (err) {
      console.error('[detail] 云数据初始化失败：', err);
    }

    const openid = store.getOpenId();
    let post = store.findPost(id);

    // 缓存里没有（冷启动 / 分享直达）→ 再拉一次
    if (!post) {
      try {
        await store.syncPosts();
        post = store.findPost(id);
      } catch (err) {
        console.error('[detail] 拉取帖子失败：', err);
      }
    }

    if (!post) {
      this.setData({ notFound: true });
      return;
    }

    // 发帖人视角：authorOpenid 是我
    const isOwner = !!openid && post.authorOpenid === openid;

    // 【审查拦截】status === 'auditing'（被举报打码 / 待复核）：任何人都不允许进入详情，
    // 包括发帖人本人（先退回大厅，避免本人反复点自己的帖子又看不到）
    if (post.status === 'auditing') {
      wx.showToast({ title: AUDITING_BLOCK_MESSAGE, icon: 'none', duration: 1500 });
      backToHall(1500);
      return;
    }

    // 热度防刷：同一用户对同一帖子、同一天只计一次浏览热度（云端原子自增）
    let heat = store.resolveHeat(post);
    if (store.claimHeatOnce(post.id, openid, store.HEAT_ACTION.VIEW)) {
      heat += 1;
      try {
        await store.persistHeat(post.id, heat);
      } catch (err) {
        console.warn('[detail] 浏览热度写入失败：', err);
      }
    }

    // 是否已申请过（禁止重复申请）
    const myApplication = store.getApplications().find(function (app) {
      return app.postId === post.id && app.applicantId === openid;
    }) || null;
    const hasApplied = !!(myApplication && myApplication.status !== 'rejected');
    const appliedStatus = myApplication ? myApplication.status : '';
    const appliedText = appliedStatus === 'accepted'
      ? '已通过，去任务页看联系方式'
      : '已申请，等待审核';

    const category = post.category;

    this.setData({
      post: Object.assign({}, post, {
        heat: heat,
        tags: post.tags || []
      }),
      category: category,
      categoryKey: CATEGORY_MAP[category] ? category : 'other',
      categoryText: CATEGORY_MAP[category] || '其他',
      statusText: POST_STATUS_MAP[post.status],
      statusKey: post.status,
      isOwner: isOwner,
      hasApplied: hasApplied,
      isEnded: post.status === 'ended',
      appliedStatus: appliedStatus,
      appliedText: appliedText,
      notFound: false
    });
  },

  // 底部主按钮统一入口
  onActionClick: function () {
    if (this.data.isOwner) {
      // 发帖人：去任务页管理申请（task 是 TabBar 页，必须用 switchTab）
      wx.switchTab({
        url: '/pages/task/task'
      });
      return;
    }

    // 已结束的帖子禁止申请
    if (this.data.isEnded) {
      wx.showToast({ title: '该招募已结束', icon: 'none' });
      return;
    }

    if (this.data.hasApplied) {
      // 已通过：引导去任务页看发帖人联系方式
      if (this.data.appliedStatus === 'accepted') {
        wx.switchTab({
          url: '/pages/task/task'
        });
        return;
      }
      wx.showToast({ title: '已申请过，请等待发起人审核', icon: 'none' });
      return;
    }

    this.applyJoin();
  },

  // 资料未完善统一引导：提示文案由调用方传，确认后跳到「我的」（tabBar 页需 switchTab）
  ensureProfileReady: function (content) {
    wx.showModal({
      title: '资料未完善',
      content: content || '请先在「我的」页面完善资料',
      confirmText: '去完善',
      success: function (res) {
        if (res.confirm) {
          wx.switchTab({ url: '/pages/profile/profile' });
        }
      }
    });
  },

  applyJoin: async function () {
    const post = this.data.post;
    if (!post) return;

    // 兜底：已结束的帖子不再接收新申请
    if (post.status === 'ended') {
      wx.showToast({ title: '该招募已结束', icon: 'none' });
      return;
    }

    const openid = store.getOpenId();
    if (!openid) {
      wx.showToast({ title: '账号信息未就绪，请稍后重试', icon: 'none' });
      return;
    }

    // 0. 身份前提：展示名与联系方式都必须来自你自己在「我的」填的资料（云端 users 集合）
    const nickname = store.getNickname();
    if (!nickname) {
      this.ensureProfileReady('申请前请先在「我的」页面填写并保存昵称，申请人展示名取这里');
      return;
    }

    const applicantContact = (store.getProfile().contact || '').trim();
    if (!applicantContact) {
      this.ensureProfileReady('申请时需要把你的联系方式交给发起人，请先在「我的」页面填写联系方式');
      return;
    }

    // 1. 写入一条 pending 申请（带申请人自己填的联系方式 + 学号，仅 accepted 后对发帖人可见）
    const application = {
      postId: post.id,
      applicantId: openid,
      applicantName: nickname,
      applicantContact: applicantContact,
      applicantStudentId: (store.getProfile().studentId || '').trim(),
      receiverId: post.authorOpenid || post._openid || '',
      status: 'pending',
      createTime: Date.now()
    };

    try {
      await store.addApplication(application);
    } catch (err) {
      console.error('[detail] 申请写入失败：', err);
      wx.showToast({ title: '申请发送失败，请稍后重试', icon: 'none' });
      return;
    }

    // 2. 热度 +5：同一用户对同一帖子只贡献一次申请热度
    let heat = store.resolveHeat(post);
    if (store.claimHeatOnce(post.id, openid, store.HEAT_ACTION.APPLY)) {
      heat += 5;
      try {
        await store.persistHeat(post.id, heat);
      } catch (err) {
        console.warn('[detail] 申请热度写入失败：', err);
      }
    }

    this.setData({
      hasApplied: true,
      appliedStatus: 'pending',
      appliedText: '已申请，等待审核',
      'post.heat': heat
    });

    wx.showToast({ title: '申请已发送，请等待审核', icon: 'none' });
  },

  /**
   * 【发帖人】结束寻呼：底部左侧小字按钮
   * 二次确认后把 status 改为 'ended' 并记录 endTime（云端数据库写入，仅本人有权改自己这条）
   * 结束后：大厅「最新发布 / 最热招募」不再展示，只在「往期历史」里按 endTime 排序
   */
  onEndClick: function () {
    const post = this.data.post;
    if (!post) return;
    if (post.status === 'ended') return; // 兜底：已结束不再弹确认框

    const that = this;
    wx.showModal({
      title: '结束寻呼',
      content: '结束后该信息将移入「往期历史」，且不再接收新的申请。确定结束吗？',
      confirmText: '结束',
      confirmColor: '#e53935',
      cancelText: '再等等',
      success: function (res) {
        if (!res.confirm) return;
        that.doEndPost();
      }
    });
  },

  // 真正写入：status -> ended + endTime
  doEndPost: async function () {
    const post = this.data.post;
    if (!post) return;

    wx.showLoading({ title: '处理中...', mask: true });

    let endTime;
    try {
      endTime = await store.endPost(post.id);
    } catch (err) {
      wx.hideLoading();
      console.error('[detail] 结束寻呼失败 code=' + (err && err.code) + '：', err);
      wx.showToast({ title: (err && err.message) || '结束失败，请稍后重试', icon: 'none' });
      return;
    }

    wx.hideLoading();

    // 本页立即同步为已结束：左侧按钮变「已结束」置灰，顶部状态徽章同步
    this.setData({
      post: Object.assign({}, post, { status: 'ended', endTime: endTime }),
      statusKey: 'ended',
      statusText: POST_STATUS_MAP.ended,
      isEnded: true
    });

    wx.showToast({ title: '已结束该寻呼', icon: 'none' });
  },

  /**
   * 举报：ActionSheet 选分类 -> Modal 填描述 -> 云函数 report
   * 云端写入 reports 集合，并把帖子 status 改成 auditing（大厅打码 + 不可点入）
   */
  onReportClick: function () {
    const that = this;
    if (!this.data.post) return;

    wx.showActionSheet({
      itemList: REPORT_CATEGORIES,
      success: function (res) {
        that.openReportModal(REPORT_CATEGORIES[res.tapIndex]);
      }
    });
  },

  openReportModal: function (category) {
    const that = this;
    wx.showModal({
      title: '举报：' + category,
      editable: true,
      placeholderText: '请补充具体描述，方便我们核实处理',
      confirmText: '提交',
      success: function (res) {
        if (!res.confirm) return;
        that.submitReport(category, res.content || '');
      }
    });
  },

  submitReport: async function (category, description) {
    const post = this.data.post;
    if (!post) return;

    wx.showLoading({ title: '提交中...', mask: true });

    let result;
    try {
      result = await store.submitReport({
        postId: post.id,
        reason: category,
        desc: (description || '').trim()
      });
    } catch (err) {
      wx.hideLoading();
      console.error('[detail] 举报提交失败 code=' + (err && err.code) + '：', err);

      if (err && err.code === 'SELF_REPORT') {
        wx.showToast({ title: '不能举报自己发布的内容', icon: 'none' });
        return;
      }
      wx.showToast({ title: (err && err.message) || '举报失败，请稍后重试', icon: 'none' });
      return;
    }

    wx.hideLoading();

    // 已结束的帖子只记举报、不改状态
    if (result.status === 'ended') {
      wx.showToast({ title: '举报已记录，感谢反馈', icon: 'none' });
      return;
    }

    wx.showToast({ title: '举报成功，该内容已进入审查', icon: 'none', duration: 1500 });

    // 帖子已进入审查：本页已经不能再看，同步状态后回大厅
    this.setData({
      post: Object.assign({}, post, { status: 'auditing' }),
      statusKey: 'auditing',
      statusText: POST_STATUS_MAP.auditing
    });
    backToHall(1600);
  }
});
