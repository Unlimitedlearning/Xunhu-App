// pages/profile/profile.js
// 个人页：登录（只确认 openid，不造身份） + 资料维护（云端 users 集合） + 收到的评价
//
// 职责划分（重构后）：
//   前端：展示与收集输入；登录态只记一个本地标记 isLogin
//   云端：login 证明 openid；user 云函数读写 users 集合（昵称/学号/简历/联系方式）
// 任何「默认姓名 / 默认学号 / 默认简历 / 默认微信号」都不再存在。

const store = require("../../utils/store");
const constants = require("../../utils/constants");

const STUDENT_ID_REGEX = constants.STUDENT_ID_REGEX;

Page({
  data: {
    isLogin: false,
    nickname: '',
    studentId: '',
    isStudentIdBound: false, // 云端已有合法学号 -> 输入框禁用、不可修改
    avatarText: '?',
    resume: '',
    contact: '',
    isProfileReady: false, // 昵称 + 联系方式 + 广工学号格式均合格才为 true
    reviews: []            // 暂无评价数据源（不再塞静态假评价）
  },

  onShow: function () {
    this.refreshProfile();
  },

  /**
   * 资料只从云端读；拉不到就渲染空表单，绝不用本地假数据填充
   */
  refreshProfile: async function () {
    if (!store.isLoggedIn()) {
      this.setData({
        isLogin: false,
        nickname: '',
        studentId: '',
        isStudentIdBound: false,
        avatarText: '?',
        resume: '',
        contact: '',
        isProfileReady: false,
        reviews: []
      });
      return;
    }

    try {
      await store.syncProfile();
    } catch (err) {
      console.error('[profile] 云端资料同步失败：', err);
    }

    const profile = store.getProfile();

    this.setData({
      isLogin: true,
      nickname: profile.nickname || '',
      studentId: profile.studentId || '',
      // 云端已有合法学号即视为「已绑定」：输入框禁用，且与服务端的学号锁同一判定标准
      isStudentIdBound: STUDENT_ID_REGEX.test((profile.studentId || '').trim()),
      avatarText: (profile.nickname || '?').slice(0, 1),
      resume: profile.resume || '',
      contact: profile.contact || '',
      // 严格判定：昵称 + 联系方式 + 学号格式（与 guard / 发布 / 申请同一套规则）
      isProfileReady: store.isProfileReady(),
      reviews: []
    });
  },

  // 点击登录：只换 openid 与云端资料，不弹任何微信授权框
  // （OpenID 由云函数 login 下发，无需用户授权）；云端已有资料就直接渲染，不让用户重填
  handleLogin: async function () {
    wx.showLoading({ title: '登录中...' });
    try {
      await store.login();
      wx.hideLoading();
      await this.refreshProfile();
      wx.showToast({
        title: store.isProfileReady() ? '登录成功' : '登录成功，请完善昵称与联系方式',
        icon: 'none'
      });
    } catch (err) {
      wx.hideLoading();
      console.error('[profile] 登录失败：', err);
      wx.showToast({ title: '登录失败，请检查云环境', icon: 'none' });
    }
  },

  // 退出：必须二次确认（退出直接影响发布/申请能力）
  handleLogout: function () {
    const that = this;
    wx.showModal({
      title: '退出登录',
      content: '退出后需重新登录才能发布和申请，确定退出吗？',
      confirmText: '确定',
      cancelText: '取消',
      success: function (res) {
        if (!res.confirm) return;
        store.logout();
        that.refreshProfile();
        wx.showToast({ title: '已退出登录', icon: 'none' });
      }
    });
  },

  onNicknameInput: function (e) {
    const nickname = e.detail.value || '';
    this.setData({
      nickname: nickname,
      // 文字头像实时跟随昵称首字，用户能立刻看到「填什么就显示什么」
      avatarText: (nickname.trim() || '?').slice(0, 1)
    });
  },

  onStudentIdInput: function (e) {
    this.setData({ studentId: e.detail.value || '' });
  },

  // 「学号被他人占用？」：只给线下申诉路径，平台不收证件影像
  onStudentIdOccupied: function () {
    wx.showModal({
      title: '学号申诉',
      content: '为保护个人隐私，平台绝不收集任何身份证或学生证照片。如需申诉，请直接联系管理员邮箱（xunhu_app@qq.com），并携带学生证进行线下核实。',
      showCancel: false,
      confirmText: '我知道了'
    });
  },

  onResumeInput: function (e) {
    this.setData({ resume: e.detail.value });
  },

  onContactInput: function (e) {
    this.setData({ contact: e.detail.value });
  },

  // 保存资料到云端 users 集合（不再是本地 Storage）
  saveProfile: async function () {
    if (!this.data.isLogin) return;

    const nickname = (this.data.nickname || '').trim();
    if (!nickname) {
      wx.showToast({ title: '请先填写昵称', icon: 'none' });
      return;
    }

    // 学号：必填 + 广工 10 位格式（云函数里还有同样一道，防绕过）
    const studentId = (this.data.studentId || '').trim();
    if (!studentId) {
      wx.showToast({ title: '请填写学号，用于本校学生身份认证', icon: 'none' });
      return;
    }
    if (!STUDENT_ID_REGEX.test(studentId)) {
      wx.showToast({ title: '请输入正确的广工 10 位学号', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '保存中...' });
    try {
      await store.saveProfile({
        nickname: nickname,
        studentId: studentId,
        resume: this.data.resume || '',
        contact: this.data.contact || ''
      });
      wx.hideLoading();
      await this.refreshProfile();

      // 保存成功：第一句确认写入，第二句告诉用户「权限已经解锁」
      wx.showToast({ title: '保存成功', icon: 'success', duration: 900 });
      setTimeout(function () {
        wx.showToast({
          title: store.isProfileReady()
            ? '现在您可以前往大厅发布需求了'
            : '昵称、学号与联系方式都填好即可解锁大厅功能',
          icon: 'none',
          duration: 2500
        });
      }, 900);
    } catch (err) {
      wx.hideLoading();
      console.error('[profile] 资料保存失败：', err);

      const code = err && err.code;
      if (code === 'STUDENT_ID_TAKEN') {
        // 学号被他人占用：这是安全拦截，用弹窗而不是 toast
        wx.showModal({
          title: '学号已被绑定',
          content: '该学号已被绑定，请勿盗用他人学号',
          showCancel: false,
          confirmText: '我知道了'
        });
      } else if (code === 'STUDENT_ID_INVALID') {
        wx.showToast({ title: '学号格式不合法，拒绝保存', icon: 'none' });
      } else {
        wx.showToast({
          title: (err && err.message) || '保存失败，请确认 user 云函数已部署',
          icon: 'none'
        });
      }
    }
  },

  /**
   * 协议 / 隐私指引跳转
   * 双重保障：<navigator> 自身能跳；这里再给链接文字加 catchtap（阻断冒泡，不会再触发 navigator 默认行为），
   * 真正用 wx.navigateTo 跳一次，任何情况下都只跳一页，且失败时不再“无声无息”。
   */
  onAgreementTap: function (e) {
    const path = e.currentTarget.dataset.path || '/pages/agreement/agreement';
    wx.navigateTo({
      url: path,
      fail: function (err) {
        console.error('[agreement] navigateTo fail:', err);
        wx.showToast({
          title: '页面跳转失败，请重新编译后再试',
          icon: 'none'
        });
      }
    });
  }
});
