// pages/profile/profile.js
// 个人页：登录（只确认 openid，不造身份） + 资料维护（云端 users 集合） + 收到的评价（reviews 集合）
//
// 职责划分（重构后）：
//   前端：展示与收集输入；登录态只记一个本地标记 isLogin
//   云端：login 证明 openid；user 云函数读写 users 集合（昵称/学号/简历/联系方式）
//         review 云函数读 reviews 集合（我作为 revieweeOpenid 收到的评价，匿名下发）
// 任何「默认姓名 / 默认学号 / 默认简历 / 默认微信号 / 假评价」都不再存在。

const store = require("../../utils/store");
const constants = require("../../utils/constants");

const STUDENT_ID_REGEX = constants.STUDENT_ID_REGEX;

// 时间戳 -> YYYY-MM-DD（个人页只展示日期，够用也不占宽度）
function formatReviewTime(timestamp) {
  const value = Number(timestamp) || 0;
  if (!value) return '';
  const date = new Date(value);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return date.getFullYear() + '-' + (month < 10 ? '0' + month : month) + '-' + (day < 10 ? '0' + day : day);
}

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

    // ---- 收到的评价（reviews 集合，全部匿名） ----
    reviewTotal: 0,                        // 收到多少条评价（含没写文字的）
    reviewGoodCount: 0,                    // 其中满意（rating = 1）的条数
    reviewRate: 0,                         // 好评率百分比，由云端算好
    showReviewRate: false,                 // 总数 >= 3 才展示好评率，否则只显示「满意度统计中...」
    reviewPendingText: constants.REVIEW_PENDING_TEXT,
    reviewMinCount: constants.REVIEW_MIN_COUNT,
    reviewEmptyText: '还没有收到评价',
    reviews: []                            // [{ id, fromName: '某同学', content, ratingText, isGood, createTime }]
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
        reviewTotal: 0,
        reviewGoodCount: 0,
        reviewRate: 0,
        showReviewRate: false,
        reviewEmptyText: '还没有收到评价',
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
      isProfileReady: store.isProfileReady()
    });

    // 评价单独拉：reviews 拉取失败不影响资料表单可用
    await this.loadReviews();
  },

  /**
   * 拉取「我作为被评价人」的评价（云函数 review -> action: 'received'）
   * 云端只回传 rating / content / createTime；评价人一律用「某同学」占位，真匿名
   */
  loadReviews: async function () {
    try {
      await store.syncReceivedReviews();
    } catch (err) {
      console.error('[profile] 评价拉取失败（review 云函数是否已部署？）：', err);
    }
    this.renderReviews();
  },

  renderReviews: function () {
    const stat = store.getReceivedReviews();
    const total = stat.total || 0;
    // 展示规则：< 3 条只显示「满意度统计中...」；>= 3 条才给好评率
    const showRate = total >= constants.REVIEW_MIN_COUNT;

    const reviews = (stat.list || [])
      .filter(function (item) {
        return !!(item && item.content); // 只展示有文字的评价（纯打分不进列表）
      })
      .map(function (item) {
        return {
          id: item.reviewId || String(item.createTime || ''),
          fromName: constants.REVIEW_ANONYMOUS_NAME,
          content: item.content,
          isGood: item.rating === 1,
          ratingText: item.rating === 1 ? '满意' : '不满意',
          createTime: formatReviewTime(item.createTime)
        };
      });

    this.setData({
      reviewTotal: total,
      reviewGoodCount: stat.goodCount || 0,
      reviewRate: stat.rate || 0,
      showReviewRate: showRate,
      reviewEmptyText: total > 0 ? '收到的评价暂未填写文字' : '还没有收到评价',
      reviews: reviews
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
   * 意见反馈与帮助：只弹管理邮箱（平台不收在线工单，避免造一个没人处理的入口）
   */
  onFeedbackTap: function () {
    wx.showModal({
      title: '意见反馈与帮助',
      content: '如有任何问题或产品建议，请联系管理邮箱：xunhu_app@qq.com',
      showCancel: false,
      confirmText: '我知道了'
    });
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
