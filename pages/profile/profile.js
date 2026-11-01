// pages/profile/profile.js
// 个人页：模拟登录 + 个人信息维护 + 收到评价

const store = require("../../utils/store");
const constants = require("../../utils/constants");

const CURRENT_USER = constants.CURRENT_USER;
const STORAGE_KEYS = constants.STORAGE_KEYS;
const DEFAULT_PROFILE = constants.DEFAULT_PROFILE;

// 收到的评价（静态展示）
const REVIEW_LIST = [
  { id: 'review_1', fromName: '张同学', content: '技术强，守时', createTime: '2025-12-18' },
  { id: 'review_2', fromName: '陈同学', content: '沟通顺畅', createTime: '2025-12-10' },
  { id: 'review_3', fromName: '黄同学', content: '配合默契，改需求也有耐心', createTime: '2025-11-29' }
];

Page({
  data: {
    isLogin: false,
    userName: '',
    studentId: '',
    avatarText: '',
    resume: '',
    contact: '',
    reviews: []
  },

  onShow: function () {
    this.refreshProfile();
  },

  /**
   * 登录状态与资料都从 Storage 读，未登录时不渲染资料模块
   */
  refreshProfile: function () {
    if (!store.isLoggedIn()) {
      this.setData({
        isLogin: false,
        userName: '',
        studentId: '',
        avatarText: '',
        resume: '',
        contact: '',
        reviews: []
      });
      return;
    }

    const saved = wx.getStorageSync(STORAGE_KEYS.PROFILE) || {};

    this.setData({
      isLogin: true,
      userName: CURRENT_USER.name,
      studentId: CURRENT_USER.studentId,
      avatarText: CURRENT_USER.name.slice(0, 1),
      resume: typeof saved.resume === 'string' ? saved.resume : DEFAULT_PROFILE.resume,
      contact: typeof saved.contact === 'string' ? saved.contact : DEFAULT_PROFILE.contact,
      reviews: REVIEW_LIST
    });
  },

  // 点击登录：写 Storage 后刷新页面数据
  handleLogin: function () {
    store.setLoggedIn(true);
    this.refreshProfile();
    wx.showToast({ title: '登录成功', icon: 'success' });
  },

  handleLogout: function () {
    store.setLoggedIn(false);
    this.refreshProfile();
    wx.showToast({ title: '已退出登录', icon: 'none' });
  },

  onResumeInput: function (e) {
    this.setData({ resume: e.detail.value });
  },

  onContactInput: function (e) {
    this.setData({ contact: e.detail.value });
  },

  // 保存资料到本地
  saveProfile: function () {
    if (!this.data.isLogin) return;

    wx.setStorageSync(STORAGE_KEYS.PROFILE, {
      resume: (this.data.resume || '').trim(),
      contact: (this.data.contact || '').trim()
    });

    wx.showToast({ title: '资料已保存', icon: 'success' });
  }
});
