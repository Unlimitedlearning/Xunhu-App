// pages/task/task.js
// 任务页：申请流转工作台 + 双向评价入口
// 入口校验：未登录 / 资料未完善（昵称 + 联系方式）不展示申请列表，只给一个去完善的入口
//
// 评价规则（防互刷，真正拦截在云函数 review）：
//   显示条件：申请 accepted **且** 关联帖子 ended
//   同一个帖子里的同一个人只能评价一次（一个帖子招多个队友时，B 和 C 要能分别评）：
//   已评价过 -> 按钮变【已评价】并置灰不可点，不允许再弹出评价表单
//   （云端 handleSubmit 另有一道 ALREADY_REVIEWED 绝对拦截，条件 = postId + 双方 openid）

const store = require("../../utils/store");
const guard = require("../../utils/guard");
const constants = require("../../utils/constants");
const tabBadge = require("../../utils/tabBadge");

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
    reviewTarget: { openid: '', name: '', postId: '' },
    reviewRating: -1,                             // -1 未选（0 是「不满意」，不能用来表示未选）
    reviewContent: '',
    reviewSubmitting: false
  },

  onShow: function () {
    // 底部「我的」红点：本页在 TabBar 上，把缓存里的未读状态重新落一次（零网络请求）
    tabBadge.reapply();

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

    // 1) 缓存先行（秒开）：本地快照 -> 内存缓存 -> 立即渲染
    this.renderCachedList();
    // 2) 再静默拉云端：全部拉完后再渲染一次
    this.refreshList();
  },

  /**
   * 缓存先行：本地快照 -> 内存缓存 -> renderList（幂等，会话内只执行一次）
   * 拿不到 openid 时不渲染：那时无法区分「我发出的 / 我收到的」，会误闪空状态
   */
  renderCachedList: function () {
    if (this.cachedRendered) return;
    if (!store.getOpenId()) return;

    const cached = store.hydrateFromCache();
    if (!cached.applications) return; // 没快照（首次使用 / 退出登录后）：等 refreshList

    this.cachedRendered = true;
    this.renderList();
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

  // 云端刷缓存 -> 同步渲染（只拉云端、不读本地快照：下拉刷新 / 页面停留后看到的都是最新状态）
  refreshList: async function () {
    this.cachedRendered = true; // 云端已拉过，后续 onShow 不再用快照闪旧数据
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

    // 我已发出的评价：按 postId 标记「已评价」并锁按钮，失败不影响申请列表本身
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
   *
   * 数据来源（v1.3.0 起）：以云函数 application.list 下发的字段为准 ——
   * 云端已经联查了 posts（标题 / 状态 / 发帖人 / 联系方式）与 users（申请人昵称 / 简历），
   * 内存里的帖子缓存只做兜底（云函数降级模式下用）。
   *
   * 隐私红线：联系方式与学号严格对等，只有 status === 'accepted' 才下发 contact / studentId 给 WXML
   *   type = 'sent'     我发出的申请 -> accepted 才看得到发帖人 contact 与完整学号（app.authorStudentId）
   *   type = 'received' 我收到的申请 -> accepted 才看得到申请人 contact 与完整学号（app.applicantStudentId）
   * pending / rejected 时一律为空，不往渲染层传（避免无权限的人从渲染层挖学号）
   */
  formatApplication: function (app, posts, type) {
    const post = posts.find(function (item) {
      return item && item.id === app.postId;
    }) || null;

    const status = app.status;
    const isAccepted = status === 'accepted';
    const openid = store.getOpenId();

    // 帖子信息：云函数 application.list 联查下发的优先，内存里的帖子缓存只做兜底
    const postTitle = app.postTitle || (post ? post.title : '') || '该信息已被删除';
    const postStatus = app.postStatus || (post ? post.status : '');
    const authorName = app.authorName || (post ? post.authorName : '') || '未知';

    let contact = '';
    let studentId = '';
    if (isAccepted) {
      if (type === 'sent') {
        // 我发出的申请：发帖人联系方式（post_contacts）+ 发帖人完整学号（云端现查 users）
        contact = app.contact || (post ? post.contact : '') || '';
        studentId = app.authorStudentId || '';
      } else {
        // 我收到的申请：申请人联系方式 + 申请人完整学号
        contact = app.applicantContact || '';
        studentId = app.applicantStudentId || '';
      }
    }

    // ---- 申请人信息（发帖人判断要不要同意的唯一依据）----
    const applicantName = app.applicantName || '对方同学';
    const applicantResume = app.applicantResume || '';
    const applyNote = app.applyNote || '';
    const applyNoteText = applyNote || constants.APPLY_NOTE_EMPTY_TEXT;

    // ---- 评价入口 ----
    // sent：我申请了别人的帖子 -> 评价发帖人；received：我发的帖子 -> 评价申请人
    const revieweeOpenid = type === 'sent'
      ? (app.authorOpenid || (post ? (post.authorOpenid || '') : ''))
      : (app.applicantId || '');
    const revieweeName = type === 'sent'
      ? authorName
      : (app.applicantName || '对方');
    const postEnded = postStatus === 'ended';
    // 显示条件：accepted + 帖子 ended + 对方不是自己
    const canReview = isAccepted && postEnded && !!revieweeOpenid && revieweeOpenid !== openid;
    // 同一个帖子里的同一个人只能评一次：按键 = postId + 对方 openid（一个帖子招多人时 B、C 互不影响）；
    // 云端已判定重复提交的（如另一台设备刚评过、mine 未刷新）用页面临时锁定兑上
    const myReview = canReview ? store.findMyReviewByPost(app.postId, revieweeOpenid) : null;
    const hasReviewed = !!myReview || this.isReviewLocked(app.postId, revieweeOpenid);

    // DEV_DEBUG：按钮没出现时，直接算出是哪一条没过（顺序与 canReview 的判定一致）
    let reviewHint = '';
    if (DEV_DEBUG && !canReview) {
      if (!isAccepted) {
        reviewHint = '申请状态不是 accepted（当前：' + (status || '空') + '）';
      } else if (!app.postTitle && !post) {
        reviewHint = '帖子不存在：application 下发与本地缓存都没拿到（postId=' + (app.postId || '空') +
          '）。请核对 applications 这条记录的 postId 是否等于帖子 _id，或帖子已被删除';
      } else if (!postEnded) {
        reviewHint = '帖子 status 不是 ended（当前：' + (postStatus || '空') + '）';
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
      postTitle: postTitle,
      authorName: authorName,
      applicantName: applicantName,
      applicantResume: applicantResume,
      hasResume: applicantResume.trim() !== '',
      applyNote: applyNote,
      applyNoteText: applyNoteText,
      hasApplyNote: applyNote.trim() !== '',
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
      hasReviewed: hasReviewed,
      reviewBtnText: hasReviewed ? '已评价' : '评价对方',
      revieweeOpenid: revieweeOpenid,
      revieweeName: revieweeName || '对方'
    };
  },

  // 同意 / 拒绝：走云函数 application.updateStatus（服务端校验 receiverId，越权直接拦）
  handleApplication: async function (e) {
    const id = e.currentTarget.dataset.id;
    const action = e.currentTarget.dataset.action; // accepted / rejected

    // 真机排障：dataset 拿不到 id 时，一眼能看出是模板绑错还是数据为空
    console.log('[task] 处理申请 applicationId=' + (id || '(空)') + ' action=' + (action || '(空)'));

    if (!id || (action !== 'accepted' && action !== 'rejected')) {
      wx.showToast({ title: '申请信息不完整，请下拉刷新后重试', icon: 'none' });
      return;
    }

    // 防连点：同一次请求没回来之前不发第二次（避免 accepted 之后又发 rejected）
    if (this.handlingId) return;
    this.handlingId = id;

    wx.showLoading({ title: '处理中...', mask: true });

    try {
      await store.updateApplicationStatus(id, action);
      wx.hideLoading();

      // 缓存已同步改过状态，renderList 立即渲染出「已同意 + 联系方式已解锁」
      this.renderList();

      wx.showToast({
        title: action === 'accepted' ? '已同意，联系方式已解锁' : '已拒绝该申请',
        icon: 'none'
      });
    } catch (err) {
      wx.hideLoading();
      console.error('[task] 更新申请状态失败 applicationId=' + id +
        ' action=' + action +
        ' code=' + ((err && err.code) || '') + '：', err);

      // 业务错误（越权 / 已处理 / 帖子已结束…）用云端文案，其余统一兜底
      const isBusinessError = !!(err && err.code &&
        err.code !== 'FUNCTION_CALL_FAILED' &&
        err.code !== 'APPLICATION_FAILED' &&
        err.code !== 'INTERNAL_ERROR');
      wx.showToast({
        title: isBusinessError ? err.message : '操作失败，请稍后重试',
        icon: 'none'
      });
    } finally {
      this.handlingId = '';
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

  /* ---------------- 评价：打开弹窗（同一次合作只能评一次，已评价直接锁死） ---------------- */
  onReviewTap: function (e) {
    const dataset = e.currentTarget.dataset;
    const revieweeOpenid = dataset.openid || '';
    const revieweeName = dataset.name || '对方';
    const postId = dataset.postid || '';

    if (!revieweeOpenid) {
      wx.showToast({ title: '找不到被评价人，请刷新后重试', icon: 'none' });
      return;
    }
    if (!postId) {
      wx.showToast({ title: '缺少帖子信息，请下拉刷新后重试', icon: 'none' });
      return;
    }

    // 已评价：按钮本身已置灰（disabled），这里再拦一道（防旧界面 / 误触）
    // 带上 revieweeOpenid：同一帖子里评了 B，不能连带锁住 C
    if (store.hasReviewedPost(postId, revieweeOpenid)) {
      wx.showToast({ title: constants.ALREADY_REVIEWED_MESSAGE, icon: 'none' });
      return;
    }

    this.setData({
      reviewModalShow: true,
      reviewTarget: { openid: revieweeOpenid, name: revieweeName, postId: postId },
      reviewRating: -1,
      reviewContent: ''
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
      reviewRating: -1,
      reviewContent: '',
      reviewTarget: { openid: '', name: '', postId: '' }
    });
  },

  // 弹窗卡片自身吞掉点击，避免点内容区也关窗
  noop: function () {},

  /* ---------------- 评价：提交（云端查重后只 add，提交后不可修改） ---------------- */
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
    if (!target.postId) {
      wx.showToast({ title: '缺少帖子信息，请下拉刷新后重试', icon: 'none' });
      return;
    }
    // 提交前再确认一次（防同一账号另一台设备已经评过）；按键 = 帖子 + 被评价人
    if (store.hasReviewedPost(target.postId, target.openid)) {
      this.lockReviewedButton();
      wx.showToast({ title: constants.ALREADY_REVIEWED_MESSAGE, icon: 'none' });
      return;
    }

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
        reviewRating: -1,
        reviewContent: '',
        reviewTarget: { openid: '', name: '', postId: '' }
      });

      this.lockReviewedButton(); // 按钮立刻变【已评价】+ 置灰
      wx.showToast({ title: '评价已提交', icon: 'none' });
    } catch (err) {
      this.setData({ reviewSubmitting: false });
      console.error('[task] 提交评价失败 code=' + ((err && err.code) || '') + '：', err);

      // 云端判定「本次合作已评价」：先本地锁定这条帖子，再拉一遍 mine 回缓存并重渲染
      if (err && err.code === 'ALREADY_REVIEWED') {
        this.lockReviewLocally(target.postId, target.openid);
        this.setData({
          reviewModalShow: false,
          reviewRating: -1,
          reviewContent: '',
          reviewTarget: { openid: '', name: '', postId: '' }
        });
        try {
          await store.syncMyReviews();
        } catch (syncErr) {
          console.warn('[task] 已评价状态同步失败，按本地缓存渲染：', syncErr);
        }
        this.lockReviewedButton();
      }

      wx.showToast({
        title: (err && err.message) || '评价提交失败，请稍后重试',
        icon: 'none'
      });
    }
  },

  // 提交成功 / 云端已评价：重渲染列表，按钮变【已评价】并置灰
  lockReviewedButton: function () {
    this.renderList();
  },

  /* 页面临时锁定：云端说「已评价」但 mine 还没拉回来时，也不能让按钮再亮起来。
     键 = postId + revieweeOpenid —— 只锁「这条帖子里的这个人」，不能让同帖的 C 也跟着变灰 */
  isReviewLocked: function (postId, revieweeOpenid) {
    if (!postId || !revieweeOpenid) return false;
    return !!(this.reviewedPostIds && this.reviewedPostIds[postId + '|' + revieweeOpenid]);
  },

  lockReviewLocally: function (postId, revieweeOpenid) {
    if (!postId || !revieweeOpenid) return;
    this.reviewedPostIds = this.reviewedPostIds || {};
    this.reviewedPostIds[postId + '|' + revieweeOpenid] = true;
  }
});
