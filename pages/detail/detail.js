// pages/detail/detail.js
// 详情页：读取帖子完整内容，处理「申请加入」与「举报」
// 数据源：云函数 post（action: get / contact）+ utils/store 的缓存层
//         （posts 集合对客户端零权限，本页不直接访问数据库）

const store = require("../../utils/store");
const constants = require("../../utils/constants");
const subscribe = require("../../utils/subscribe");

const CATEGORY_MAP = constants.CATEGORY_MAP;
const POST_STATUS_MAP = constants.POST_STATUS_MAP;
const REPORT_CATEGORIES = constants.REPORT_CATEGORIES;
const AUDITING_BLOCK_MESSAGE = constants.AUDITING_BLOCK_MESSAGE;
const RESUME_PREVIEW_CHARS = constants.AUTHOR_RESUME_PREVIEW_CHARS;

// 申请相关的文案 / 上限统一放 constants（与云函数 application 同值）
const APPLY_CONTACT_WARNING = constants.APPLY_CONTACT_WARNING;
const APPLY_NOTE_MAX = constants.APPLY_NOTE_MAX;
const APPLY_NOTE_PLACEHOLDER = constants.APPLY_NOTE_PLACEHOLDER;

// 时间戳 -> YYYY-MM-DD（详情页评价只展示日期，够用也不占宽度）
function formatReviewTime(timestamp) {
  const value = Number(timestamp) || 0;
  if (!value) return '';
  const date = new Date(value);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return date.getFullYear() + '-' + (month < 10 ? '0' + month : month) + '-' + (day < 10 ? '0' + day : day);
}

// 退回大厅（detail 可能是分享直达打开，栈里没上一页，统一 switchTab 回大厅）
function backToHall(delay) {
  setTimeout(function () {
    wx.switchTab({ url: '/pages/index/index' });
  }, delay || 1200);
}

Page({
  data: {
    post: null,
    categoryKey: '',
    categoryText: '',
    statusText: '',
    statusKey: '',
    isOwner: false,
    hasApplied: false,
    isEnded: false,
    appliedStatus: '',
    appliedText: '',
    notFound: false,
    // 管理员预览（仅管理后台点举报卡片标题进来时置 true）：
    // 放宽「审查中不可入」拦截，但同时隐藏报名/举报按钮、不加热度
    adminPreview: false,

    // ---- 发布者名片（申请人建立信任用：简历 / 满意度 / 最近 3 条匿名评价）----
    // 初值直接用 store 的兜底结构：名片还没回来时 wxml 也不会取到 undefined
    authorCard: store.emptyAuthorCard(),
    resumeExpanded: false,   // 简历是否已展开
    resumeLong: false,       // 简历是否超过 3 行预览长度（超过才显示「展开全文」）
    reviewSubText: '',       // 满意度下面那行小字（条数 / 统计中）
    resumeEmptyText: constants.AUTHOR_RESUME_EMPTY_TEXT,
    reviewEmptyText: constants.AUTHOR_REVIEW_EMPTY_TEXT
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
    // 缓存里没有（冷启动 / 分享直达）：先用 _id 直取这一条（1 次请求）。
    // v1.3.0 起列表只同步最新 20 条，靠 syncPosts() 会漏掉较早的帖子（分享链接进来就白屏）。
    if (!post) {
      post = await store.fetchPostById(id);
    }
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

    // 【审查拦截】status === 'auditing'（被举报打码 / 待复核）：普通用户与发帖人本人都不可进入；
    // 唯一例外是管理员预览（?admin=1）：先向云端重拉资料，确认 role === 'admin' 才放行。
    // 注意：posts 本来对所有用户可读，拦截只是产品体验层；这里多一道 role 校验，是为了不让
    // 「改包加个 admin=1」就能把审查中的内容当正常帖子看。
    let adminPreview = false;
    if (options && options.admin === '1') {
      try {
        await store.syncProfile();
      } catch (err) {
        console.error('[detail] 管理员预览校验失败，按普通用户处理：', err);
      }
      adminPreview = store.isAdmin();
    }

    if (post.status === 'auditing' && !adminPreview) {
      wx.showToast({ title: AUDITING_BLOCK_MESSAGE, icon: 'none', duration: 1500 });
      backToHall(1500);
      return;
    }

    // 热度防刷：同一用户对同一帖子、同一天只计一次浏览热度（云端原子自增）
    // 管理员预览不计热度：审核行为不应该把被举报的帖子顶到「最热」
    let heat = store.resolveHeat(post);
    if (!adminPreview && store.claimHeatOnce(post.id, openid, store.HEAT_ACTION.VIEW)) {
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
      categoryKey: CATEGORY_MAP[category] ? category : 'other',
      categoryText: CATEGORY_MAP[category] || '其他',
      statusText: POST_STATUS_MAP[post.status],
      statusKey: post.status,
      isOwner: isOwner,
      hasApplied: hasApplied,
      isEnded: post.status === 'ended',
      appliedStatus: appliedStatus,
      appliedText: appliedText,
      adminPreview: adminPreview,
      notFound: false
    });

    // 发布者名片单独拉：不 await，避免云函数慢时整页白屏等它
    // （名片失败了也只是显示空名片，帖子正文/申请按钮不受影响）
    this.loadAuthorCard(post);

    // 作者本人：联系方式已从 posts 迁到 post_contacts（客户端不可读写），
    // 只能由云函数 post 按关系（作者本人 / 已同意申请）下发
    if (isOwner) this.loadOwnerContact(post);
  },

  /**
   * 作者本人看自己填的联系方式（底部「联系方式」那一行）
   * 非作者不调用：申请人只能在「任务页」同意之后看到，联系方式不再随帖子公开下发。
   */
  loadOwnerContact: async function (post) {
    if (!post || !post.id || post.status === 'draft') return;
    const contact = await store.fetchPostContact(post.id);
    if (contact) this.setData({ 'post.contact': contact });
  },

  /**
   * 发布者名片：一次云函数同时拿 users 简历 + reviews 匿名统计
   * 首屏走本地 Storage 快照（cache_author_{authorOpenid}）秒开，后台再静默拉云端覆盖：
   * 缓存在前、云端在后，用户先看到内容，再静默校正，与大厅列表同一套思路。
   * @param {object} post 当前帖子（用它的 id 让云端自己查 authorOpenid，不信客户端传的身份）
   */
  loadAuthorCard: async function (post) {
    if (!post) return;

    // 本地草稿不是云端文档（没有 _id / authorOpenid），直接渲染兜底名片，
    // 省一次必然返回 AUTHOR_REQUIRED 的云调用
    if (post.status === 'draft' || !post.authorOpenid) {
      this.renderAuthorCard(store.emptyAuthorCard(), post);
      return;
    }

    const authorOpenid = post.authorOpenid;

    // 1) 首屏：先拿缓存 setData（同步，不产生请求）
    const cachedCard = store.readAuthorCardCache(authorOpenid);
    if (cachedCard) this.renderAuthorCard(cachedCard, post, { keepExpanded: true });

    // 2) 静默更新：后台拉最新简历 / 评价
    let card;
    try {
      card = await store.fetchAuthorProfile({
        postId: post.id,
        authorOpenid: authorOpenid
      });
    } catch (err) {
      // store 已经兜底返回空名片，这里只是双保险：失败就保留首屏缓存
      console.warn('[detail] 发布者名片加载失败，已保留缓存名片：', err);
      return;
    }

    // ready = false 说明是降级兜底（云函数未部署 / 网络失败 / 无发帖人），
    // 这种结果不能覆盖已有缓存，否则会把原本能看到的名片刷成空白
    if (!card || !card.ready) {
      if (!cachedCard) this.renderAuthorCard(store.emptyAuthorCard(), post);
      return;
    }

    this.renderAuthorCard(card, post, { keepExpanded: true });
    store.writeAuthorCardCache(authorOpenid, card);
  },

  /**
   * 把名片渲染到页面
   * @param {object} card store 归一化后的名片（已含昵称 / 简历 / 好评率文案）
   * @param {object} post 当前帖子（只用于昵称兜底）
   * @param {{keepExpanded?:boolean}} options keepExpanded：静默更新时不把已展开的简历收回去
   */
  renderAuthorCard: function (card, post, options) {
    const source = card || store.emptyAuthorCard();
    // 昵称兜底：名片里没有就用帖子上记的 authorName（旧帖 / 名片接口未部署时仍能显示名字）
    const nickname = (source.nickname || '').trim() || ((post && post.authorName) || '');
    const resume = source.resume || '';
    const reviews = (source.reviews || []).map(function (item) {
      return Object.assign({}, item, { createTimeText: formatReviewTime(item.createTime) });
    });
    // 3 行大约 60 个字，超过这个长度才给「展开全文」，避免短简历也挂个没用的按钮
    const resumeLong = resume.length > RESUME_PREVIEW_CHARS;

    this.setData({
      authorCard: Object.assign({}, source, {
        nickname: nickname,
        avatarText: source.avatarText || (nickname ? nickname.slice(0, 1) : '?'),
        resume: resume,
        hasResume: resume.trim() !== '',
        reviews: reviews
      }),
      reviewSubText: this.buildReviewSubText(source),
      resumeLong: resumeLong,
      // 只有「本来就是展开状态 + 静默更新」才保留展开，其余情况默认收起
      resumeExpanded: !!(options && options.keepExpanded) && resumeLong && !!this.data.resumeExpanded
    });
  },

  // 昵称下面那行小字：好评率与总条数已在右上角徽章展示（constants.formatReviewRateText），
  // 这里只补一句「其中几条满意」；一条评价都没收到时返回空串，wxml 整行不渲染
  buildReviewSubText: function (card) {
    const total = card.reviewTotal || 0;
    if (!total) return '';
    return '其中满意 ' + (card.reviewGoodCount || 0) + ' 条';
  },

  // 简历展开 / 收起（只切换样式，不重新请求）
  onToggleResume: function () {
    if (!this.data.resumeLong) return;
    this.setData({ resumeExpanded: !this.data.resumeExpanded });
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

  // 申请第一步：弹窗填写「申请附言」（必填，存入 applications.applyNote）
  // 为什么必须先采集：附言是发帖人判断「要不要同意」的唯一依据，之前完全没采集，
  // 发帖人在任务页只能看到一个昵称，只能盲选。
  // @return {Promise<string|null>} 填写内容（已 trim）；取消 / 空内容 / 超长返回 null
  askApplyNote: function () {
    return new Promise(function (resolve) {
      wx.showModal({
        title: '申请附言',
        editable: true,
        placeholderText: APPLY_NOTE_PLACEHOLDER,
        confirmText: '下一步',
        cancelText: '取消',
        success: function (res) {
          if (!res.confirm) {
            resolve(null);
            return;
          }

          const note = String(res.content || '').trim();
          if (!note) {
            wx.showToast({ title: '请先填写申请附言', icon: 'none' });
            resolve(null);
            return;
          }
          if (note.length > APPLY_NOTE_MAX) {
            wx.showToast({ title: '申请附言最多 ' + APPLY_NOTE_MAX + ' 个字', icon: 'none' });
            resolve(null);
            return;
          }

          // 前端轻量拦截（与发布同一套词库）；云端 application 还有一道绝对防线
          const violation = constants.checkTextViolation(note);
          if (!violation.pass) {
            wx.showToast({ title: constants.violationMessage('报名', violation.word), icon: 'none' });
            resolve(null);
            return;
          }

          resolve(note);
        },
        fail: function () {
          resolve(null); // 弹窗异常（极罕见）当作用户未填写，不发请求
        }
      });
    });
  },

  // 申请前二次确认：警告「联系方式必须真实，虚假联系会被封号」，用户点确认才写库
  confirmApply: function () {
    return new Promise(function (resolve) {
      wx.showModal({
        title: '申请加入',
        content: APPLY_CONTACT_WARNING,
        confirmText: '确认申请',
        cancelText: '再想想',
        success: function (res) {
          resolve(!!res.confirm);
        },
        fail: function () {
          resolve(false); // 弹窗异常（极罕见）当作用户未确认，不发请求
        }
      });
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

    // 1. 身份前提：展示名与联系方式都必须来自你自己在「我的」填的资料（云端 users 集合）
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

    // 2. 一次性订阅消息授权：
    //    位置很关键 —— 必须紧跟点击、在本轮同步代码里发起（上面全是同步校验，没有 await），
    //    否则微信会判定「非用户点击触发」直接 fail（errCode 20004）。
    //    返回值用户看不到也不影响流程：拒绝授权只是收不到通知，绝不能卡死业务。
    await subscribe.requestApplySubscribe();

    // 3. 弹窗填写申请附言（必填）—— 附言会直接展示在发帖人的任务页
    const applyNote = await this.askApplyNote();
    if (!applyNote) return;

    // 4. 再弹一次警告：联系方式必须真实，虚假联系会被封禁（用户确认后才落库）
    const confirmed = await this.confirmApply();
    if (!confirmed) return;

    // 5. 写库：只传 postId + applyNote，昵称 / 学号 / 联系方式 / 简历 由云函数从 users 取
    //    （以前是前端自己拼快照：改包就能冒用他人昵称，而且字段缺漏导致发帖人看不到信息）
    try {
      await store.addApplication({ postId: post.id, applyNote: applyNote });
    } catch (err) {
      console.error('[detail] 申请写入失败 code=' + ((err && err.code) || '') + '：', err);
      wx.showToast({
        title: (err && err.code !== 'FUNCTION_CALL_FAILED' && err.message) || '申请发送失败，请稍后重试',
        icon: 'none'
      });
      return;
    }

    // 6. 热度 +5：同一用户对同一帖子只贡献一次申请热度
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
   * 【发帖人】结束信息：底部左侧小字按钮
   * 二次确认后把 status 改为 'ended' 并记录 endTime（云端数据库写入，仅本人有权改自己这条）
   * 结束后：大厅「最新发布 / 最热招募」不再展示，只在「往期历史」里按 endTime 排序
   */
  onEndClick: function () {
    const post = this.data.post;
    if (!post) return;
    if (post.status === 'ended') return; // 兜底：已结束不再弹确认框

    const that = this;
    wx.showModal({
      title: '结束信息',
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
      console.error('[detail] 结束信息失败 code=' + (err && err.code) + '：', err);
      // 云函数未部署时不把开发者文案招给用户
      const msg = (err && err.code !== 'FUNCTION_CALL_FAILED' && err.message) || '结束失败，请稍后重试';
      wx.showToast({ title: msg, icon: 'none' });
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

    wx.showToast({ title: '已结束该信息', icon: 'none' });
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
