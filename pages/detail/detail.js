// pages/detail/detail.js
// 详情页：从 mockData + 本地缓存读取完整内容，并处理「申请加入」

const mockData = require("../../utils/mockData");

// 写死的当前登录用户（演示用，与发布页 / 任务页保持一致）
const CURRENT_USER = {
  name: '林同学',
  openid: 'openid_mock_lin'
};

// 分类字典
const categoryMap = {
  'team': '组队',
  'resume': '自荐',
  'partner': '搭子'
};

// 状态字典
const statusMap = {
  'draft': '草稿',
  'auditing': '审核中',
  'active': '寻呼中',
  'ended': '已结束'
};

// 发帖人姓名 -> openid（mockData 里的约定，用于生成申请的 receiverId）
const AUTHOR_OPENID_MAP = {
  '张同学': 'openid_mock_zhang',
  '李同学': 'openid_mock_li',
  '王同学': 'openid_mock_wang',
  '陈同学': 'openid_mock_chen',
  '林同学': 'openid_mock_lin',
  '黄同学': 'openid_mock_huang'
};

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
    const post = this.findPost(id);

    if (!post) {
      this.setData({ notFound: true });
      return;
    }

    // 热度：合并本地已持久化的热度值
    const baseHeat = this.resolveHeat(post);

    // PRD：进入详情页 heat +1（浏览记一次热度）
    const heat = baseHeat + 1;
    this.persistHeat(post.id, heat);

    // 发帖人视角：作者是我
    const isOwner = post.authorName === CURRENT_USER.name
      || (post.authorOpenid && post.authorOpenid === CURRENT_USER.openid);

    // 是否已申请过（禁止重复申请）
    const apps = this.getApplications();
    const myApplication = apps.find(function (app) {
      return app.postId === post.id && app.applicantId === CURRENT_USER.openid;
    }) || null;
    const hasApplied = !!(myApplication && myApplication.status !== 'rejected');
    const appliedStatus = myApplication ? myApplication.status : '';
    const appliedText = appliedStatus === 'accepted'
      ? '已通过，去任务页看联系方式'
      : '已申请，等待审核';

    const rawCategory = post.category || post.PostCategory || '';

    this.setData({
      post: Object.assign({}, post, {
        heat: heat,
        tags: post.tags || [],
        content: post.content || post.desc || '',
        authorName: post.authorName || post.author || '匿名同学'
      }),
      category: rawCategory,
      categoryKey: categoryMap[rawCategory] ? rawCategory : 'other',
      categoryText: categoryMap[rawCategory] || '其他',
      statusText: statusMap[post.status] || '',
      statusKey: statusMap[post.status] ? post.status : '',
      isOwner: isOwner,
      hasApplied: hasApplied,
      appliedStatus: appliedStatus,
      appliedText: appliedText,
      notFound: false
    });
  },

  // 大厅 -> 详情：先找本地缓存（自己发的帖），再找 mockData
  findPost: function (id) {
    if (!id) return null;
    const localPosts = wx.getStorageSync('local_posts') || [];
    const cloudPosts = mockData.postList || [];
    const allPosts = localPosts.concat(cloudPosts);
    return allPosts.find(function (item) {
      return item && item.id === id;
    }) || null;
  },

  // 读取申请数据：优先本地，没有则用 mock 兜底
  getApplications: function () {
    const localApps = wx.getStorageSync('local_applications');
    if (localApps && localApps.length > 0) return localApps;
    return mockData.mockApplications || [];
  },

  // 本地热度覆盖表：让 +1 / +5 的热度能跨页面、跨重启保持一致
  resolveHeat: function (post) {
    const overrides = wx.getStorageSync('local_heat_overrides') || {};
    const baseHeat = typeof post.heat === 'number' ? post.heat : 0;
    const savedHeat = overrides[post.id];
    return (typeof savedHeat === 'number' && savedHeat > baseHeat) ? savedHeat : baseHeat;
  },

  persistHeat: function (postId, heat) {
    const overrides = wx.getStorageSync('local_heat_overrides') || {};
    overrides[postId] = heat;
    wx.setStorageSync('local_heat_overrides', overrides);

    // 自己发的帖：同步草稿箱里的热度
    let localPosts = wx.getStorageSync('local_posts') || [];
    let changed = false;
    localPosts = localPosts.map(function (item) {
      if (item && item.id === postId) {
        changed = true;
        return Object.assign({}, item, { heat: heat });
      }
      return item;
    });
    if (changed) wx.setStorageSync('local_posts', localPosts);

    // 同步内存中的 mockData，保证返回大厅时热度一致
    (mockData.postList || []).forEach(function (item) {
      if (item.id === postId) item.heat = heat;
    });
  },

  // 底部按钮统一入口
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

    const apps = this.getApplications();

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

    wx.setStorageSync('local_applications', apps.concat(newApplication));

    // 2. 热度 +5
    const heat = (post.heat || 0) + 5;
    this.persistHeat(post.id, heat);

    this.setData({
      hasApplied: true,
      appliedStatus: 'pending',
      appliedText: '已申请，等待审核',
      'post.heat': heat
    });

    wx.showToast({ title: '申请已发送，请等待审核', icon: 'none' });
  }
});
