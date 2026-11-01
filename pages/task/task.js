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

// ==================== DEV_DEBUG 排障开关 ====================
// true  = 任务页顶部显示一行调试信息（openid / 帖子数 / 申请数 / 拉取错误），
//         且每张「没出现评价按钮」的卡片下面会直接写出是哪一条判定没过。
// false = 全部隐藏，界面回到干净状态（不影响任何判定与数据）。
// 为什么加它：canReview 是 4 个条件串联，之前任何一个 false 都只能靠猜。
// 【内测状态】已置 false：黄色调试条 + 卡片下的「⚠ 无评价按钮」红字都不会渲染给测试同学
//             也不会打任何 [task][DEV] 日志。需要排障时临时改回 true 再编译即可。
const DEV_DEBUG = false;

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
    devDebug: DEV_DEBUG,      // DEV_DEBUG：顶部调试条 + 卡片下的「为什么没按钮」提示
    devInfo: {},

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
    // 帖子与申请必须一起重新拉。
    // 旧逻辑只在「帖子缓存为空」时才拉 posts，于是：在控制台把帖子改成 ended、
    // 或其他端结束后，任务页一直用启动时的旧 status 判断 postEnded —— 评价按钮永远不出现。
    try {
      await store.syncPosts();
    } catch (err) {
      console.warn('[task] 帖子列表刷新失败，先用缓存判断：', err);
    }

    try {
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

    // 帖子与申请都拉完后，把「申请里出现、但帖子列表缓存里找不到」的 postId 按 _id 再直取一次。
    // 为什么要有这一步：列表缓存是「分页 + orderBy(createTime)」拉进来的，可能漏掉个别帖子，
    // 而评价按钮要求 app.postId 能对应到帖子 —— 帖子明明在库里、按钮却永远不出现，就是这个原因。
    await this.patchMissingPosts();

    this.renderList();
  },

  // 补拉「申请引用了、但列表缓存里没有」的帖子（按 _id 直取，不受分页/排序影响）
  patchMissingPosts: async function () {
    const apps = store.getApplications();
    if (!apps.length) return;

    const openid = store.getOpenId();
    const ids = [];
    apps.forEach(function (app) {
      if (!app || !app.postId) return;
      // 只看与自己相关的申请，避免为无关数据发无意义的请求
      if (app.applicantId !== openid && app.receiverId !== openid) return;
      if (store.findPost(app.postId)) return;   // 缓存里有就不用补
      if (ids.indexOf(app.postId) < 0) ids.push(app.postId);
    });
    if (!ids.length) return;

    if (DEV_DEBUG) console.log('[task][DEV] 缓存缺失，按 _id 补拉帖子：', ids);

    const results = await Promise.all(ids.map(function (id) {
      return store.fetchPostById(id);
    }));

    if (DEV_DEBUG) {
      results.forEach(function (post, index) {
        if (!post) console.warn('[task][DEV] 帖子按 _id 直取失败（已删除 / postId 写错 / 无读权限）：', ids[index]);
      });
    }
  },

  renderList: function () {
    const apps = store.getApplications();
    const posts = store.getPosts();
    const openid = store.getOpenId();

    // DEV_DEBUG：把判定依据摆到界面上，不再靠猜
    let devInfo = {};
    if (DEV_DEBUG) {
      const err = store.getApplicationsError();
      const errText = err
        ? String(err.errMsg || err.message || err.errCode || '未知错误')
        : '';
      devInfo = {
        openid: openid || '(空)',
        postCount: posts.length,
        postIds: posts.slice(0, 5).map(function (p) { return p.id; }).join(' / '),
        appCount: apps.length,
        appError: errText
      };
      console.log('[task][DEV] openid=' + openid,
        'posts=' + posts.length, 'apps=' + apps.length,
        errText ? 'appErr=' + errText : '');
    }

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
      receivedList: receivedList,
      devInfo: devInfo
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

    // DEV_DEBUG：按钮没出现时，直接算出是哪一条没过（顺序与 canReview 的判定一致）
    let reviewHint = '';
    if (DEV_DEBUG && !canReview) {
      if (!isAccepted) {
        reviewHint = '申请状态不是 accepted（当前：' + (status || '空') + '）';
      } else if (!post) {
        // 最常见的坑：控制台里 _openid 和 _id 长得很像（都是 28 位左右），手抄容易把
        // 作者的 openid 当成文档 _id 填进 postId。直接在这里点名提示。
        const hitAuthor = posts.find(function (item) {
          return item && item.authorOpenid && item.authorOpenid === app.postId;
        });
        reviewHint = hitAuthor
          ? 'app.postId 填的是作者 _openid（' + app.postId + '），不是帖子文档的 _id。应把「' +
            (hitAuthor.title || '该帖子') + '」这条文档的 _id 字段填进 postId'
          : '帖子不存在：列表缓存里没有，按 _id 直取也失败（postId=' + (app.postId || '空') +
            '）。请核对 applications 这条记录的 postId 是否等于帖子 _id，或帖子已被删除';
      } else if (!postEnded) {
        reviewHint = '帖子 status 不是 ended（当前：' + (post.status || '空') + '）';
      } else if (!revieweeOpenid) {
        reviewHint = type === 'sent'
          ? '帖子没有 authorOpenid 字段，拿不到被评价人'
          : '申请没有 applicantId 字段，拿不到被评价人';
      } else if (revieweeOpenid === openid) {
        reviewHint = '被评价人就是自己（自评被拦，属正常业务规则）';
      } else {
        reviewHint = '未知原因';
      }
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
      createTime: app.createTime || 0,
      // 评价相关
      canReview: canReview,
      postEnded: postEnded,
      reviewHint: reviewHint,
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
        icon: 'none'
      });
    } catch (err) {
      console.error('[task] 更新申请状态失败：', err);
      wx.showToast({ title: '操作失败，请稍后重试', icon: 'none' });
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
      wx.showToast({ title: isUpdate ? '评价已更新' : '评价已提交', icon: 'none' });
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
