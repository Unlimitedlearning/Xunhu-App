// pages/task/task.js
// 任务页：申请流转工作台
// 入口校验：未登录 / 资料未完善（昵称 + 联系方式）不展示申请列表，只给一个去完善的入口

const store = require("../../utils/store");
const guard = require("../../utils/guard");
const constants = require("../../utils/constants");

const APPLICATION_STATUS_MAP = constants.APPLICATION_STATUS_MAP;

Page({
  data: {
    tabs: ['我发出的申请', '我收到的申请'],
    activeTab: 0,
    sentList: [],
    receivedList: [],
    ready: false,      // 已登录 + 资料完善：满足才渲染申请列表
    guardTitle: '',
    guardTip: ''
  },

  onShow: function () {
    const isLogin = store.isLoggedIn();
    const ready = isLogin && store.isProfileReady();

    this.setData({
      ready: ready,
      guardTitle: isLogin ? '资料未完善' : '还未登录',
      guardTip: isLogin
        ? '您还没有完善联系方式/昵称，队友无法联系您。完善后再回来查看申请。'
        : '请先前往「我的」页面登录，登录并完善资料后才能查看申请。'
    });

    if (!ready) {
      // 资料不全时不拉申请列表：联系方式拿不到，列表看了也用不了
      this.setData({ sentList: [], receivedList: [] });
      this.promptGuard(isLogin);
      return;
    }

    this.guardPrompted = false;
    this.refreshList();
  },

  // 进入任务页时的拦截提示（同一次进入只弹一次，避免 onShow 反复弹）
  promptGuard: function (isLogin) {
    if (this.guardPrompted) return;
    this.guardPrompted = true;
    if (isLogin) {
      guard.promptProfile();
    } else {
      guard.promptLogin();
    }
  },

  // UI 上的「去完善」入口
  goProfile: function () {
    guard.goProfile();
  },

  onTabChange: function (e) {
    this.setData({
      activeTab: Number(e.currentTarget.dataset.index)
    });
  },

  // 云端刷缓存 -> 同步渲染
  refreshList: async function () {
    try {
      // 帖子缓存为空时补拉一次（任务页要用它显示帖子标题/发帖人）
      if (!store.getPosts().length) await store.syncPosts();
      await store.syncApplications();
    } catch (err) {
      console.error('[task] 云数据拉取失败：', err);
      if (!this.hasShownLoadError) {
        this.hasShownLoadError = true;
        wx.showToast({ title: '申请数据加载失败，请稍后重试', icon: 'none' });
      }
    }
    this.renderList();
  },

  renderList: function () {
    const apps = store.getApplications();
    const posts = store.getPosts();
    const openid = store.getOpenId();

    // Tab 1：我发出的申请（applicantId === 我）
    const sentList = apps
      .filter(function (app) {
        return app && app.applicantId === openid;
      })
      .map(app => this.formatApplication(app, posts, 'sent'))
      .sort((a, b) => b.createTime - a.createTime);

    // Tab 2：我收到的申请（receiverId === 我）
    const receivedList = apps
      .filter(function (app) {
        return app && app.receiverId === openid;
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
   * 漏洞三：联系方式严格对等，只有 status === 'accepted' 才下发 contact / studentId 给 WXML
   *   type = 'sent'     我发出的申请 -> accepted 才看得到发帖人 contact
   *   type = 'received' 我收到的申请 -> accepted 才看得到申请人 contact 与完整学号
   * pending / rejected 时一律为空，不往渲染层传（避免无权限的人从渲染层挖学号）
   */
  formatApplication: function (app, posts, type) {
    const post = posts.find(function (item) {
      return item && item.id === app.postId;
    }) || null;

    const status = app.status;
    const isAccepted = status === 'accepted';

    let contact = '';
    let studentId = '';
    if (isAccepted) {
      contact = type === 'sent'
        ? (post ? post.contact : '')
        : (app.applicantContact || '');
      // 完整学号只在「已同意」后展示给发帖人（对方申请时自己填的），其余一律空
      studentId = type === 'received' ? (app.applicantStudentId || '') : '';
    }

    return {
      id: app.id,
      postId: app.postId,
      postTitle: post ? post.title : '该寻呼已被删除',
      authorName: post ? post.authorName : '未知',
      applicantName: app.applicantName,
      status: status,
      statusText: APPLICATION_STATUS_MAP[status] || '未知状态',
      isPending: status === 'pending',
      isAccepted: isAccepted,
      contact: contact,
      studentId: studentId,
      createTime: app.createTime || 0
    };
  },

  // 同意 / 拒绝：写回云数据库
  handleApplication: async function (e) {
    const id = e.currentTarget.dataset.id;
    const action = e.currentTarget.dataset.action; // accepted / rejected
    if (!id || (action !== 'accepted' && action !== 'rejected')) return;

    try {
      await store.updateApplicationStatus(id, action);
      this.renderList();
      wx.showToast({
        title: action === 'accepted' ? '已同意申请' : '已拒绝申请',
        icon: 'success'
      });
    } catch (err) {
      console.error('[task] 更新申请状态失败：', err);
      wx.showToast({ title: '操作失败，请检查集合权限', icon: 'none' });
    }
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
