// pages/task/task.js
// 任务页：申请流转工作台 + 双向评价入口
// 入口校验：未登录 / 资料未完善（昵称 + 联系方式）不展示申请列表，只给一个去完善的入口
//
// 评价规则（防互刷，真正拦截在云函数 review）：
//   显示条件：申请 accepted **且** 关联帖子 ended（双方各只能对同一人保留一条评价）
//   有旧评价 -> 弹窗回填 + 按钮/提交键都叫「更新评价」；无 -> 空白表单

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
    guardTip: '',

    // ---- 评价弹窗 ----
    reviewMaxLength: constants.REVIEW_CONTENT_MAX, // 与云端 MAX_CONTENT、textarea maxlength 同一值
    reviewModalShow: false,
    reviewIsUpdate: false,                        // true = 回填旧数据，提交即覆盖更新
    reviewTarget: { openid: '', name: '', postId: '' },
    reviewRating: -1,                             // -1 未选（0 是「不满意」，不能用来表示未选）
    reviewContent: '',
    reviewSubmitting: false
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
      // 帖子缓存为空时补拉一次（任务页要用它显示标题/发帖人，也要判断帖子是否已结束）
      if (!store.getPosts().length) await store.syncPosts();
      await store.syncApplications();
    } catch (err) {
      console.error('[task] 云数据拉取失败：', err);
      if (!this.hasShownLoadError) {
        this.hasShownLoadError = true;
        wx.showToast({ title: '申请数据加载失败，请稍后重试', icon: 'none' });
      }
    }

    // 我已发出的评价：只用来标记「已评价 / 更新评价」，失败不影响申请列表本身
    try {
      await store.syncMyReviews();
    } catch (err) {
      console.warn('[task] 我的评价列表拉取失败，按钮先按「未评价」渲染：', err);
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
    const openid = store.getOpenId();

    let contact = '';
    let studentId = '';
    if (isAccepted) {
      contact = type === 'sent'
        ? (post ? post.contact : '')
        : (app.applicantContact || '');
      // 完整学号只在「已同意」后展示给发帖人（对方申请时自己填的），其余一律空
      studentId = type === 'received' ? (app.applicantStudentId || '') : '';
    }

    // ---- 评价入口 ----
    // sent：我申请了别人的帖子 -> 评价发帖人；received：我发的帖子 -> 评价申请人
    const revieweeOpenid = type === 'sent'
      ? (post ? (post.authorOpenid || '') : '')
      : (app.applicantId || '');
    const revieweeName = type === 'sent'
      ? (post ? post.authorName : '')
      : (app.applicantName || '对方');
    const postEnded = !!(post && post.status === 'ended');
    // 显示条件：accepted + 帖子 ended + 对方不是自己
    const canReview = isAccepted && postEnded && !!revieweeOpenid && revieweeOpenid !== openid;
    const myReview = canReview ? store.findMyReviewTo(revieweeOpenid) : null;

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
      createTime: app.createTime || 0,
      // 评价相关
      canReview: canReview,
      postEnded: postEnded,
      hasReviewed: !!myReview,
      reviewBtnText: myReview ? '更新评价' : '评价对方',
      revieweeOpenid: revieweeOpenid,
      revieweeName: revieweeName || '对方'
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
  },

  /* ---------------- 评价：打开弹窗（有旧评价就回填） ---------------- */
  onReviewTap: async function (e) {
    const dataset = e.currentTarget.dataset;
    const revieweeOpenid = dataset.openid || '';
    const revieweeName = dataset.name || '对方';
    const postId = dataset.postid || '';

    if (!revieweeOpenid) {
      wx.showToast({ title: '找不到被评价人，请刷新后重试', icon: 'none' });
      return;
    }

    // 1) 先看内存缓存（刚拉过 mine，命中就秒开）
    let review = store.findMyReviewTo(revieweeOpenid);

    // 2) 缓存没有：再向云端确认一次（查本地/云端是否存在旧评价）
    if (!review) {
      wx.showLoading({ title: '加载中...' });
      try {
        review = await store.fetchMyReviewTo(revieweeOpenid);
      } catch (err) {
        console.error('[task] 查询历史评价失败：', err);
        // 查询失败不阻止用户写评价：按「没有旧评价」处理，提交时云端仍会 upsert
      } finally {
        wx.hideLoading();
      }
    }

    this.setData({
      reviewModalShow: true,
      reviewIsUpdate: !!review,
      reviewTarget: { openid: revieweeOpenid, name: revieweeName, postId: postId },
      reviewRating: review ? review.rating : -1,
      reviewContent: review ? review.content : ''
    });
  },

  onReviewRatingTap: function (e) {
    const rating = Number(e.currentTarget.dataset.rating);
    if (rating !== 1 && rating !== 0) return;
    this.setData({ reviewRating: rating });
  },

  onReviewContentInput: function (e) {
    this.setData({ reviewContent: e.detail.value || '' });
  },

  closeReviewModal: function () {
    if (this.data.reviewSubmitting) return; // 提交中不允许关闭，避免重复提交/闪回
    this.setData({
      reviewModalShow: false,
      reviewIsUpdate: false,
      reviewRating: -1,
      reviewContent: '',
      reviewTarget: { openid: '', name: '', postId: '' }
    });
  },

  // 弹窗卡片自身吞掉点击，避免点内容区也关窗
  noop: function () {},

  /* ---------------- 评价：提交（云端 upsert，A 对 B 永远只有一条） ---------------- */
  submitReview: async function () {
    if (this.data.reviewSubmitting) return;

    const rating = this.data.reviewRating;
    if (rating !== 1 && rating !== 0) {
      wx.showToast({ title: '请选择满意或不满意', icon: 'none' });
      return;
    }

    const target = this.data.reviewTarget || {};
    if (!target.openid) {
      wx.showToast({ title: '缺少被评价人，请重新打开', icon: 'none' });
      return;
    }

    const isUpdate = this.data.reviewIsUpdate;
    this.setData({ reviewSubmitting: true });

    try {
      await store.submitReview({
        postId: target.postId,
        revieweeOpenid: target.openid,
        rating: rating,
        content: this.data.reviewContent
      });

      this.setData({
        reviewSubmitting: false,
        reviewModalShow: false,
        reviewIsUpdate: false,
        reviewRating: -1,
        reviewContent: '',
        reviewTarget: { openid: '', name: '', postId: '' }
      });

      this.renderList(); // 按钮立刻变成「更新评价」+ 已评价标记
      wx.showToast({ title: isUpdate ? '评价已更新' : '评价已提交', icon: 'success' });
    } catch (err) {
      this.setData({ reviewSubmitting: false });
      console.error('[task] 提交评价失败：', err);
      wx.showToast({
        title: (err && err.message) || '评价提交失败，请稍后重试',
        icon: 'none'
      });
    }
  }
});
