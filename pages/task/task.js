// pages/task/task.js
// 任务页：申请流转工作台（纯本地数据闭环）

const store = require("../../utils/store");
const constants = require("../../utils/constants");

const CURRENT_USER = constants.CURRENT_USER;
const APPLICATION_STATUS_MAP = constants.APPLICATION_STATUS_MAP;

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

  refreshList: function () {
    const apps = store.getApplications();
    const posts = store.getPosts();

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

    const status = app.status;

    return {
      id: app.id,
      postId: app.postId,
      postTitle: post ? post.title : '该寻呼已被删除',
      authorName: post ? post.authorName : '未知',
      applicantName: app.applicantName,
      status: status,
      statusText: APPLICATION_STATUS_MAP[status] || '未知状态',
      isPending: status === 'pending',
      contact: (type === 'sent' && status === 'accepted' && post) ? post.contact : '',
      createTime: app.createTime || 0
    };
  },

  // 同意 / 拒绝：更新本地 Storage 里的状态
  handleApplication: function (e) {
    const id = e.currentTarget.dataset.id;
    const action = e.currentTarget.dataset.action; // accepted / rejected
    if (!id || (action !== 'accepted' && action !== 'rejected')) return;

    store.updateApplicationStatus(id, action);
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
