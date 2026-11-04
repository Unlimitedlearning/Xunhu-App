// pages/publish/publish.js
// 发布页：校验 + 上传（云函数 publish：云端严格防御 + 直接上线）
// 风控分层：
//   第一层（本页）前端轻量拦截：title/content/tags/contact 拼全文 -> constants.checkTextViolation
//             命中直接 toast 具体违规词，不发请求（纯体验，能被改包绕过）
//   第二层（云端）绝对防线：cloudfunctions/publish 写入前用同一套词库 + 净化正则再校一遍（真的拦截）
// 状态流转（v1.8.0：首帖审核已取消，只有「有前科」的号会进 auditing）：
//   通过  -> 云端直接写 status: 'active'（进行中，大厅可见可点入）
//   有前科 -> status: 'auditing'，提示「已提交审核，通过后自动上线」
//   拦截  -> 不写库，表单保留，提示「发布失败：包含违规词汇【xxx】，请修改后重试。」
//   网络/云端异常 -> 存本地草稿（key = publish_draft），下次进发布页自动恢复

const store = require("../../utils/store");
const constants = require("../../utils/constants");
const subscribe = require("../../utils/subscribe");

const CATEGORY_LIST = constants.CATEGORY_LIST;
const CONTENT_RISKY_MESSAGE = constants.CONTENT_RISKY_MESSAGE;
// 一人一帖文案（与云函数 publish 的 ALREADY_HAS_ACTIVE 提示保持一致）
const ACTIVE_POST_LIMIT_MESSAGE = constants.ACTIVE_POST_LIMIT_MESSAGE;
// 违禁词校验统一走 constants.checkTextViolation（净化匹配：小写 + 去空白 + 去全部标点 + 拼音兜底）
const checkTextViolation = constants.checkTextViolation;

/* ---------------- 本地草稿（v1.8.0 重新接上） ----------------
 * key = 'publish_draft'（与 constants.STORAGE_KEYS.DRAFT 同一个值，改一处必须同步）。
 * 只存一份：草稿是「本次没发出去的内容」，多份草稿反而让用户不知道哪份是新的。
 * 只在「网络 / 云函数异常」时落盘 —— 违规内容绝不能写进本地反复提交。
 */
const DRAFT_KEY = constants.STORAGE_KEYS.DRAFT; // = 'publish_draft'
// 草稿文档 ID：与 utils/store.js 的 DRAFT_ID 同值，大厅「草稿」卡片靠它认这份草稿
const DRAFT_ID = 'local_draft';

/**
 * 拼草稿对象：补 id / status / createTime，形状与 store.getPosts() 里那张「草稿」卡片一致
 * （少了 id，store.getDraft() 会当无效数据丢掉，大厅也就没有「草稿」标识）
 */
function buildDraft(postData) {
  return Object.assign({}, postData, {
    id: DRAFT_ID,
    status: 'draft',
    createTime: (postData && postData.createTime) || Date.now()
  });
}

/* ---------------- 违禁词全文匹配工具 ---------------- */

/**
 * 全文本拼接：标题 + 描述 + 标签 + 联系方式 -> 一个完整长字符串
 * 为什么必须拼一起：分字段各自匹配会被「拆字」绕过
 *   例：标题写「代」、正文写「课」，单字段都不含「代课」，拼起来才露馅
 */
function buildFullText(title, content, tags, contact) {
  return [title, content, (tags || []).join(' '), contact]
    .filter(function (item) { return !!item; })
    .join(' ');
}

Page({
  data: {
    categories: CATEGORY_LIST.map(function (item) { return item.text; }),
    categoryKeys: CATEGORY_LIST.map(function (item) { return item.key; }),
    categoryIndex: 0,
    title: '',
    content: '',
    tagStr: '',
    contact: '',
    focusField: '' // 当前聚焦的输入框：title / content / tag / contact
  },

  onLoad: async function () {
    // 云初始化（幂等）：资料来自云端 users，联系方式才能带出你自己填过的值
    try {
      await store.init();
    } catch (err) {
      console.warn('[publish] 云初始化失败，联系方式需手动填写：', err);
    }

    const profile = store.getProfile();
    const contactDefault = profile.contact || '';

    // 离线优先：找回上次上传失败的草稿（本地单份草稿）
    const draft = store.getDraft();

    if (!draft) {
      // 无草稿：联系方式预填「我的」里的值（用户自己填的，不是默认假数据）
      if (contactDefault) this.setData({ contact: contactDefault });
      return;
    }

    const index = this.data.categoryKeys.indexOf(draft.category);

    this.setData({
      categoryIndex: index > -1 ? index : 0,
      title: draft.title || '',
      content: draft.content || '',
      tagStr: (draft.tags || []).join(' '),
      contact: draft.contact || contactDefault
    });

    wx.showToast({
      title: '已恢复上次未发送的草稿',
      icon: 'none',
      duration: 2000
    });
  },

  // 资料未完善：引导去「我的」填写昵称（发布人展示名只能来自用户自己填的资料）
  ensureProfileReady: function () {
    wx.showModal({
      title: '资料未完善',
      content: '发布前请先在「我的」页面填写并保存昵称，发布人展示名取这里',
      confirmText: '去完善',
      success: function (res) {
        if (res.confirm) {
          wx.switchTab({ url: '/pages/profile/profile' });
        }
      }
    });
  },

  onCategoryChange: function (e) {
    this.setData({
      categoryIndex: Number(e.detail.value)
    });
  },

  // 输入框聚焦：给当前字段加绿边高亮（提升交互反馈）
  onFieldFocus: function (e) {
    this.setData({
      focusField: e.currentTarget.dataset.field || ''
    });
  },

  // 失焦：清空高亮
  onFieldBlur: function () {
    this.setData({ focusField: '' });
  },

  submitPost: async function () {
    const title = (this.data.title || '').trim();
    const content = (this.data.content || '').trim();
    const contact = (this.data.contact || '').trim();
    const category = this.data.categoryKeys[this.data.categoryIndex];

    // 0. 身份前提：昵称必须是你自己在「我的」里填的（云端 users 集合）
    const nickname = store.getNickname();
    if (!nickname) {
      this.ensureProfileReady();
      return;
    }

    // 1. 必填项校验
    if (!title || !content || !contact) {
      wx.showToast({ title: '标题、描述、联系方式均不能为空', icon: 'none' });
      return;
    }

    // 2. 标签：空格分隔，最多 4 个（PRD 数据模型）
    //    先解析出 tags，才能让标签一起参与违禁词匹配（标签藏违规词也是常见绕过手段）
    const tags = (this.data.tagStr || '')
      .split(' ')
      .map(item => item.trim())
      .filter(item => item !== '')
      .slice(0, 4);

    // 3. 违禁词拦截：标题 + 描述 + 标签 + 联系方式 合并成全文，做「净化匹配」
    //    净化 = 转小写 + 删空格 + 删全部中英文标点 + 删零宽字符 + 拼音兜底
    //    「代 课」「代*考」「代　课」「dai ke」都能拦住（云端有一份相同实现做绝对防线）
    const fullText = buildFullText(title, content, tags, contact);
    const violation = checkTextViolation(fullText);
    if (!violation.pass) {
      // 口径「十四」统一文案：发布失败：包含违规词汇【xxx】，请修改后重试。
      wx.showToast({ title: constants.violationMessage('发布', violation.word), icon: 'none' });
      return;
    }

    // 4. 【一次性订阅消息】发帖人侧的授权点（模板 TMPL_ACCEPT_ID：申请进度通知）。
    //    为什么必须在这里：上面 0~3 步全是同步校验，本行仍在本轮同步执行栈里；
    //    再往下第一个 await（syncMyActivePost）之后发起，微信会判「非用户点击触发」直接 fail（20004）。
    //    语义：发帖＝告诉用户「有人申请你的信息时，我给你发通知」，与云函数
    //    cloudfunctions/application 的 notifyNewApplication（发给发帖人）一一对应。
    //    用户拒绝 / 接口报错都只是 false，绝不拦截下面发布流程，所以结果不参与任何判定；
    //    但仍把这个 Promise 留住，在第 7 步弹 loading 之前 await 掉——
    //    真机上「订阅面板还开着就弹 showLoading」会把面板顶掉，等于用户授权不了。
    const subscribeTask = subscribe.requestOne(constants.TMPL_ACCEPT_ID, 'publish');

    // 5. 一人一帖：当前用户名下已有占用名额的帖子（active 进行中 / auditing 审查中）-> 弹窗拦截
    //    这里只是体验层（能改包绕过），云函数 publish 内还有一道查重做绝对防线
    let activeMine = null;
    try {
      activeMine = await store.syncMyActivePost();
    } catch (err) {
      console.warn('[publish] 发布前查重失败，交由云端 publish 兜底：', err);
    }
    if (activeMine) {
      wx.showModal({
        title: '暂时不能发布',
        content: ACTIVE_POST_LIMIT_MESSAGE,
        showCancel: false,
        confirmText: '我知道了'
      });
      return;
    }

    // 6. 按 PRD 数据模型组装（status 不在这里定：云端通过才写 'active'）
    const newPost = {
      category: category,
      title: title,
      content: content,
      tags: tags,
      authorName: nickname,
      contact: contact,
      createTime: Date.now()
    };

    // 7. 上传（云函数 publish 内部再做一次严格校一遍 + 一人一帖查重，才是绝对防线）
    //    失败分流：能改的错误现场提示（不存草稿），只有网络/云函数异常才落盘 publish_draft
    //    先等订阅授权面板关闭（无论允许/拒绝），避免 showLoading 把面板顶掉
    await subscribeTask;
    wx.showLoading({ title: '发布中...', mask: true });

    let saved = null;
    try {
      saved = await store.savePost(newPost);
    } catch (err) {
      wx.hideLoading();
      this.handleUploadError(err, newPost);
      return;
    }

    wx.hideLoading();
    // 【草稿清空】发布成功立即清掉本地草稿，否则下次进页会把已发出的内容当草稿恢复出来
    wx.removeStorageSync(DRAFT_KEY);

    // v1.8.0：只有「有前科」的账号会进人工复核，正常新号首帖直接上线
    const pending = !!(saved && saved.status === 'auditing');
    wx.showToast({
      title: pending ? '已提交审核，通过后自动上线' : '发布成功，已上线',
      icon: 'none',
      duration: pending ? 2500 : 1500
    });
    this.resetForm();
    this.backToHall(1200);
  },

  /**
   * 发布失败分流（v1.8.0：发布主流程改成 submitPost 里的 await + try/catch，失败分流抽到这里）
   * 原则：能改的错误现场提示、**不存草稿**（违规内容落盘只会被反复提交）；
   *       只有网络 / 云函数异常才写 publish_draft，用户下次进页自动回填。
   */
  handleUploadError: function (err, postData) {
    const that = this;
    console.error('[publish] 发布失败 code=' + (err && err.code) + '：', err);

    // 1. 一人一帖：云端查重命中（前端拦截可能被绕，这里才是真的拦住）
    if (err && err.code === 'ALREADY_HAS_ACTIVE') {
      wx.showModal({
        title: '暂时不能发布',
        content: err.message || ACTIVE_POST_LIMIT_MESSAGE,
        showCancel: false,
        confirmText: '我知道了'
      });
      return;
    }

    // 2. 违禁词 / 机审不通过：原地修改，不离开页面（云端标出了具体违规词就一并提示）
    if (err && err.code === 'CONTENT_RISKY') {
      // 云端已按统一句式下发「发布失败：包含违规词汇【xxx】，请修改后重试。」；
      // 旧版云端只回 hitWord 时，本地按同一句式补全
      const cloudMessage = (err && err.message) || CONTENT_RISKY_MESSAGE;
      const needCompose = !!(err && err.hitWord) && cloudMessage.indexOf('【') === -1;
      wx.showModal({
        title: '内容未通过审核',
        content: needCompose ? constants.violationMessage('发布', err.hitWord) : cloudMessage,
        showCancel: false,
        confirmText: '去修改'
      });
      return;
    }

    // 3. 资料未完善（学号/昵称/联系方式云端没有）：引导去「我的」
    if (err && err.code === 'PROFILE_NOT_READY') {
      wx.showModal({
        title: '资料未完善',
        content: err.message || '请先在「我的」页面完善资料',
        confirmText: '去完善',
        success: function (res) {
          if (res.confirm) wx.switchTab({ url: '/pages/profile/profile' });
        }
      });
      return;
    }

    // 4. 账号被封禁（users.role === 'banned'，云端拦截）：不存草稿，重启也绕不过去
    if (err && err.code === 'ACCOUNT_BANNED') {
      wx.showModal({
        title: '账号受限',
        // 统一文案（含真实管理员邮箱）：云端旧副本只回短句，这里以前端常量为准
        content: constants.BANNED_BLOCK_MESSAGE,
        showCancel: false,
        confirmText: '我知道了'
      });
      return;
    }

    // 5. 其他（网络 / 云函数未部署 / 集合不存在）：【本地草稿】落盘，不让用户白写
    //    key = 'publish_draft'，写入 title / content / tags / contact（含 category / authorName，回填时才完整）
    wx.setStorageSync(DRAFT_KEY, buildDraft(postData));
    wx.showModal({
      title: '发布未完成',
      content: '网络不佳，已为您保存草稿',
      showCancel: false,
      confirmText: '我知道了',
      success: function () {
        // 用户确认后清空表单并返回大厅（草稿已存，大厅会显示带「草稿」标识的卡片）
        that.resetForm();
        that.backToHall(1200);
      }
    });
  },

  // 清空表单（成功后调用），同时清掉聚焦高亮
  resetForm: function () {
    this.setData({
      categoryIndex: 0,
      title: '',
      content: '',
      tagStr: '',
      contact: '',
      focusField: ''
    });
  },

  // 延迟返回大厅（发布页是从大厅 navigateTo 进来的，正常能 back）
  backToHall: function (delay) {
    setTimeout(function () {
      const pages = getCurrentPages();
      if (pages.length > 1) {
        wx.navigateBack();
      } else {
        wx.switchTab({ url: '/pages/index/index' });
      }
    }, delay || 1000);
  }
});
