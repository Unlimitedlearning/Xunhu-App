// pages/publish/publish.js
// 发布页：校验 + 模拟上传 + 落地本地缓存，不连真实云端
// 状态流转：组装时默认 status: 'auditing'，上传成功保持 auditing，上传失败强改 status: 'draft'

const store = require("../../utils/store");
const constants = require("../../utils/constants");

const CATEGORY_LIST = constants.CATEGORY_LIST;
const FORBIDDEN_WORDS = constants.FORBIDDEN_WORDS;

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

  submitPost: function () {
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

    // 2. 违禁词拦截（标题 + 描述）
    const hitWord = FORBIDDEN_WORDS.find(function (word) {
      return title.indexOf(word) > -1 || content.indexOf(word) > -1;
    });
    if (hitWord) {
      wx.showToast({ title: '内容含违规词「' + hitWord + '」，请修改后重试', icon: 'none' });
      return;
    }

    // 3. 标签：空格分隔，最多 4 个（PRD 数据模型）
    const tags = (this.data.tagStr || '')
      .split(' ')
      .map(item => item.trim())
      .filter(item => item !== '')
      .slice(0, 4);

    // 4. 按 PRD 数据模型组装，状态直接默认「审核中」；id 由云端生成
    const newPost = {
      category: category,
      title: title,
      content: content,
      tags: tags,
      authorName: nickname,
      contact: contact,
      status: 'auditing', // 提交即审核中
      heat: 0,
      createTime: Date.now()
    };

    // 5. 模拟上传
    this.uploadPost(newPost);
  },

  /**
   * 模拟上传（项目暂不接真实审核后台）：
   * 成功 -> 写入云数据库 posts，status 保持 'auditing'（大厅显示橙色「审核中」）
   * 失败 -> 存成本地草稿（大厅仍能看到红色「草稿」卡片，下次进发布页可恢复）
   * 无论成功失败：清空表单 -> 延迟 1 秒返回
   */
  uploadPost: function (postData) {
    const that = this;
    wx.showLoading({ title: '发布中...' });

    setTimeout(async function () {
      wx.hideLoading();

      const isSuccess = Math.random() > 0.4; // 模拟 60% 成功率

      try {
        if (isSuccess) {
          await store.savePost(Object.assign({}, postData, { status: 'auditing' }));
          store.removeDraft(); // 上传成功后清掉旧草稿
          wx.showToast({ title: '发布成功', icon: 'success' });
        } else {
          store.saveDraft(Object.assign({}, postData, { status: 'draft' }));
          wx.showToast({ title: '网络不佳，已存草稿', icon: 'none' });
        }
      } catch (err) {
        console.error('[publish] 写入云数据库失败：', err);
        store.saveDraft(Object.assign({}, postData, { status: 'draft' }));
        wx.showToast({ title: '发布失败，已存草稿', icon: 'none' });
      }

      // 清空表单（成功失败都清），并清掉聚焦高亮
      that.setData({
        categoryIndex: 0,
        title: '',
        content: '',
        tagStr: '',
        contact: '',
        focusField: ''
      });

      // PRD：延迟 1 秒后返回大厅
      setTimeout(function () {
        wx.navigateBack();
      }, 1000);

    }, 800);
  }
});
