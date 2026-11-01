// pages/task/task.js
// 任务页：申请流转工作台（纯本地数据闭环）

const mockData = require("../../utils/mockData");

// 写死的当前登录用户（演示用，与发布页 / 详情页保持一致）
const CURRENT_USER = {
  name: '林同学',
  openid: 'openid_mock_lin'
};

// 申请状态字典
const statusMap = {
  'pending': '待处理',
  'accepted': '已同意',
  'rejected': '已拒绝'
};

Page({
  data: {
    tabs: ['我发出的申请', '我收到的申请'],
    activeTab: 0,
    sentList: [],
    receivedList: []
  },

  onShow: function () {
    // 从详情页 / 大厅返回时自动刷新
    this.refreshList();
  },

  onTabChange: function (e) {
    this.setData({
      activeTab: Number(e.currentTarget.dataset.index)
    });
  },

  // 申请数据：优先本地，没有则用 mock 兜底
  getApplications: function () {
    const localApps = wx.getStorageSync('local_applications');
    if (localApps && localApps.length > 0) return localApps;
    return mockData.mockApplications || [];
  },

  // 帖子数据：本地草稿箱 + mockData
  getAllPosts: function () {
    const localPosts = wx.getStorageSync('local_posts') || [];
    const cloudPosts = mockData.postList || [];
    return localPosts.concat(cloudPosts);
  },

  refreshList: function () {
    const apps = this.getApplications();
    const posts = this.getAllPosts();

    // Tab 1：我发出的申请（applicantId === 我）
    const sentList = apps
      .filter(function (app) {
        return app && app.applicantId === CURRENT_USER.openid;
      })
      .map(app => this.formatApplication(app, posts, 'sent'))
      .sort((a, b) => b.createTime - a.createTime);

    // Tab 2：我收到的申请（receiverId === 我）
    const receivedList = apps
      .filter(function (app) {
        return app && app.receiverId === CURRENT_USER.openid;
      })
      .map(app => this.formatApplication(app, posts, 'received'))
      .sort((a, b) => b.createTime - a.createTime);

    console.log('我发出的申请：', sentList, '我收到的申请：', receivedList);

    this.setData({
      sentList: sentList,
      receivedList: receivedList
    });
  },

  /**
   * 组装申请卡片数据
   * type = 'sent' 时，状态为 accepted 需要展示发帖人联系方式（PRD 5.4）
   */
  formatApplication: function (app, posts, type) {
    const post = posts.find(function (item) {
      return item && item.id === app.postId;
    }) || null;

    const status = app.status || 'pending';

    return {
      id: app.id,
      postId: app.postId,
      postTitle: post ? post.title : '该寻呼已被删除',
      authorName: post ? (post.authorName || post.author || '匿名同学') : '未知',
      applicantName: app.applicantName || '匿名同学',
      status: status,
      statusText: statusMap[status] || '未知状态',
      isPending: status === 'pending',
      contact: (type === 'sent' && status === 'accepted' && post) ? (post.contact || '') : '',
      createTime: app.createTime || 0
    };
  },

  // 同意 / 拒绝：更新本地 Storage 里的状态
  handleApplication: function (e) {
    const id = e.currentTarget.dataset.id;
    const action = e.currentTarget.dataset.action; // accepted / rejected
    if (!id || (action !== 'accepted' && action !== 'rejected')) return;

    const apps = this.getApplications();
    const nextApps = apps.map(function (app) {
      if (app.id === id) {
        return Object.assign({}, app, { status: action });
      }
      return app;
    });

    wx.setStorageSync('local_applications', nextApps);
    this.refreshList();

    wx.showToast({
      title: action === 'accepted' ? '已同意申请' : '已拒绝申请',
      icon: 'success'
    });
  },

  // 点击卡片查看对应帖子
  goToDetail: function (e) {
    const postId = e.currentTarget.dataset.postid;
    if (!postId) return;
    wx.navigateTo({
      url: '/pages/detail/detail?id=' + postId
    });
  }
});
