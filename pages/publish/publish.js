// pages/publish/publish.js
// 发布页：校验 + 模拟上传 + 落地本地缓存，不连真实云端
// 状态流转：组装时默认 status: 'auditing'，上传成功保持 auditing，上传失败强改 status: 'draft'

const store = require("../../utils/store");
const constants = require("../../utils/constants");

const CURRENT_USER = constants.CURRENT_USER;
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

  onLoad: function () {
    // 离线优先：找回上次上传失败的草稿（status === 'draft'）
    const draft = store.getLocalPosts().find(function (item) {
      return item && item.status === 'draft';
    });

    if (!draft) return;

    const index = this.data.categoryKeys.indexOf(draft.category);

    this.setData({
      categoryIndex: index > -1 ? index : 0,
      title: draft.title || '',
      content: draft.content || '',
      tagStr: (draft.tags || []).join(' '),
      contact: draft.contact || ''
    });

    wx.showToast({
      title: '已为您恢复上次草稿',
      icon: 'none'
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

    // 4. 按 PRD 数据模型组装，状态直接默认「审核中」
    const newPost = {
      id: 'local_' + Date.now(),
      category: category,
      title: title,
      content: content,
      tags: tags,
      authorName: CURRENT_USER.name,
      contact: contact,
      status: 'auditing', // 提交即审核中
      heat: 0,
      createTime: Date.now()
    };

    // 5. 模拟上传
    this.uploadPost(newPost);
  },

  /**
   * 模拟上传：本项目暂不接真实数据库
   * 成功 -> status 保持 'auditing'，存入 local_posts（大厅显示橙色「审核中」）
   * 失败 -> status 强改为 'draft' 后再存入 local_posts（大厅显示红色「草稿」，下次进发布页可恢复）
   * 无论成功失败：清空表单 -> 延迟 1 秒返回大厅
   */
  uploadPost: function (postData) {
    wx.showLoading({ title: '发布中...' });

    setTimeout(() => {
      wx.hideLoading();

      const isSuccess = Math.random() > 0.4; // 模拟 60% 成功率
      const savedPost = Object.assign({}, postData, {
        status: isSuccess ? 'auditing' : 'draft'
      });

      // 本地缓存只保留一份草稿，避免大厅出现多条重复草稿
      const keptPosts = store.getLocalPosts().filter(function (item) {
        return item && item.status !== 'draft';
      });
      store.saveLocalPosts(keptPosts);
      store.savePost(savedPost);

      if (isSuccess) {
        wx.showToast({ title: '发布成功', icon: 'success' });
      } else {
        wx.showToast({ title: '网络不佳，已存草稿', icon: 'none' });
      }

      // 清空表单（成功失败都清），并清掉聚焦高亮
      this.setData({
        categoryIndex: 0,
        title: '',
        content: '',
        tagStr: '',
        contact: '',
        focusField: ''
      });

      // PRD：延迟 1 秒后返回大厅
      setTimeout(() => {
        wx.navigateBack();
      }, 1000);

    }, 800);
  }
});
