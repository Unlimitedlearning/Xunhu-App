// pages/publish/publish.js
// 发布页：校验 + 上传（云函数 publish：云端严格防御 + 直接上线）
// 风控分层：
//   第一层（本页）前端轻量拦截：title/content/tags/contact 拼全文 -> constants.checkTextViolation
//             命中直接 toast 具体违规词，不发请求（纯体验，能被改包绕过）
//   第二层（云端）绝对防线：cloudfunctions/publish 写入前用同一套词库 + 净化正则再校一遍（真的拦截）
// 状态流转：
//   通过  -> 云端直接写 status: 'active'（寻呼中，大厅可见可点入）
//   拦截  -> 不写库，表单保留，提示具体违规词 / 「内容包含违规信息」
//   网络/云端异常 -> 存本地草稿（status: 'draft'），下次进发布页可恢复

const store = require("../../utils/store");
const constants = require("../../utils/constants");

const CATEGORY_LIST = constants.CATEGORY_LIST;
const CONTENT_RISKY_MESSAGE = constants.CONTENT_RISKY_MESSAGE;
// 一人一帖文案（与云函数 publish 的 ALREADY_HAS_ACTIVE 提示保持一致）
const ACTIVE_POST_LIMIT_MESSAGE = constants.ACTIVE_POST_LIMIT_MESSAGE;
// 违禁词校验统一走 constants.checkTextViolation（净化匹配：小写 + 去空白 + 去全部标点 + 拼音兜底）
const checkTextViolation = constants.checkTextViolation;

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
      title: '已为您恢复上次草稿',
      icon: 'none'
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
      wx.showToast({ title: '含违规词「' + violation.word + '」，请修改后重试', icon: 'none' });
      return;
    }

    // 4. 一人一帖：当前用户名下已有 status === 'active' 的帖子 -> 弹窗拦截
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

    // 5. 按 PRD 数据模型组装（status 不在这里定：云端通过才写 'active'）
    const newPost = {
      category: category,
      title: title,
      content: content,
      tags: tags,
      authorName: nickname,
      contact: contact,
      createTime: Date.now()
    };

    // 6. 上传（云函数 publish 内部再做一次严格校一遍 + 一人一帖查重，才是绝对防线）
    this.uploadPost(newPost);
  },

  /**
   * 上传：调云函数 publish
   *   成功 -> 云端 status = 'active'（通过直接上线）
   *   云端判定违规 -> 提示修改，**不清表单、不存草稿**（草稿是给网络故障用的，不能让违规内容落盘反复提交）
   *   其他异常 -> 存草稿，下次进发布页能恢复
   */
  uploadPost: function (postData) {
    const that = this;
    wx.showLoading({ title: '审核中...', mask: true });

    store.savePost(postData).then(function () {
      wx.hideLoading();
      store.removeDraft(); // 发布成功后清掉旧草稿
      wx.showToast({ title: '发布成功，已上线', icon: 'none' });
      that.resetForm();
      that.backToHall(1200);
    }).catch(function (err) {
      wx.hideLoading();
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
        wx.showModal({
          title: '内容未通过审核',
          content: err.hitWord
            ? '内容含违规词「' + err.hitWord + '」，请修改后重试'
            : (err.message || CONTENT_RISKY_MESSAGE),
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

      // 4. 其他（网络 / 云函数未部署 / 集合不存在）：存草稿，不让用户白写
      store.saveDraft(Object.assign({}, postData, { status: 'draft' }));
      wx.showToast({ title: '发布失败，已存草稿', icon: 'none' });
      that.resetForm();
      that.backToHall(1200);
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
