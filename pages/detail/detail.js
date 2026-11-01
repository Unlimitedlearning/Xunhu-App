// pages/detail/detail.js
// 详情页：读取帖子完整内容，处理「申请加入」与「举报」

const store = require("../../utils/store");
const constants = require("../../utils/constants");

const CURRENT_USER = constants.CURRENT_USER;
const CATEGORY_MAP = constants.CATEGORY_MAP;
const POST_STATUS_MAP = constants.POST_STATUS_MAP;
const AUTHOR_OPENID_MAP = constants.AUTHOR_OPENID_MAP;
const REPORT_CATEGORIES = constants.REPORT_CATEGORIES;
const STORAGE_KEYS = constants.STORAGE_KEYS;

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
    appliedStatus: '',
    appliedText: '',
    notFound: false
  },

  onLoad: function (options) {
    const id = (options && options.id) || '';
    const post = store.findPost(id);

    if (!post) {
      this.setData({ notFound: true });
      return;
    }

    // 发帖人视角：作者是我
    const isOwner = post.authorName === CURRENT_USER.name;

    // 状态限制：审核中的帖子只有发帖人本人能看（大厅已在入口拦截，这里再兜一层）
    if (post.status === 'auditing' && !isOwner) {
      wx.showToast({ title: '该信息还在审核中，暂不可查看', icon: 'none' });
      setTimeout(function () {
        wx.navigateBack();
      }, 1200);
      return;
    }

    // PRD：进入详情页 heat +1（浏览记一次热度）
    const heat = store.resolveHeat(post) + 1;
    store.persistHeat(post.id, heat);

    // 是否已申请过（禁止重复申请）
    const myApplication = store.getApplications().find(function (app) {
      return app.postId === post.id && app.applicantId === CURRENT_USER.openid;
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

  applyJoin: function () {
    const post = this.data.post;
    if (!post) return;

    // 1. 写入一条 pending 申请
    const newApplication = {
      id: 'app_' + Date.now(),
      postId: post.id,
      applicantId: CURRENT_USER.openid,
      applicantName: CURRENT_USER.name,
      receiverId: AUTHOR_OPENID_MAP[post.authorName] || 'openid_mock_unknown',
      status: 'pending',
      createTime: Date.now()
    };
    store.addApplication(newApplication);

    // 2. 热度 +5
    const heat = (post.heat || 0) + 5;
    store.persistHeat(post.id, heat);

    this.setData({
      hasApplied: true,
      appliedStatus: 'pending',
      appliedText: '已申请，等待审核',
      'post.heat': heat
    });

    wx.showToast({ title: '申请已发送，请等待审核', icon: 'none' });
  },

  /**
   * 举报：ActionSheet 选分类 -> Modal 填描述 -> 存本地
   * 纯前端模拟，不接真实审核后台
   */
  onReportClick: function () {
    const that = this;
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
        that.saveReport(category, res.content || '');
        wx.showToast({ title: '举报成功，感谢反馈', icon: 'none' });
      }
    });
  },

  saveReport: function (category, description) {
    const post = this.data.post;
    const reports = wx.getStorageSync(STORAGE_KEYS.REPORTS) || [];
    reports.unshift({
      id: 'report_' + Date.now(),
      postId: post ? post.id : '',
      reporterId: CURRENT_USER.openid,
      category: category,
      description: (description || '').trim(),
      createTime: Date.now()
    });
    wx.setStorageSync(STORAGE_KEYS.REPORTS, reports);
  }
});
