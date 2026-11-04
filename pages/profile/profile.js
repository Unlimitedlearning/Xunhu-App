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
const tabBadge = require("../../utils/tabBadge");

const STUDENT_ID_REGEX = constants.STUDENT_ID_REGEX;

/**
 * 资料违禁词校验的待检全文：昵称 + 简历 + 联系方式 用空格拼接
 * 为什么必须拼接：把「代」写在昵称、「课」写在简历里，逐字段查永远碰不上；
 * 简历会在详情页「发布者名片」公开展示，是黑产发广告的高发区。
 */
function buildProfileFullText(nickname, resume, contact) {
  return [nickname, resume, contact].join(' ');
}

// 校区值合法性：只认 constants.CAMPUS_LIST 里的值（历史脏数据 / 未选 -> 当作没填）
function isCampusValue(value) {
  return constants.CAMPUS_LIST.indexOf(String(value || '').trim()) > -1;
}

// 时间戳 -> YYYY-MM-DD（个人页只展示日期，够用也不占宽度）
function formatReviewTime(timestamp) {
  const value = Number(timestamp) || 0;
  if (!value) return '';
  const date = new Date(value);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return date.getFullYear() + '-' + (month < 10 ? '0' + month : month) + '-' + (day < 10 ? '0' + day : day);
}

/**
 * 账号信用文案：0 次违规 = 绿色「信用良好」；>= 1 次 = 橙红警告并带出封号阈值
 * warningCount 只能由 admin 云函数（确认违规 / 封号）或控制台写入，前端只负责展示。
 */
function buildCreditText(warningCount) {
  const count = Number(warningCount) || 0;
  if (count <= 0) return '🟢 信用良好（0 次违规）';
  const threshold = constants.WARNING_BAN_THRESHOLD;
  return '⚠️ 违规警告（当前 ' + count + '/' + threshold + ' 次，满 ' + threshold + ' 次封号）';
}

Page({
  data: {
    isLogin: false,
    nickname: '',
    // 校区（v1.6.0）：只能从 CAMPUS_OPTIONS 里选，用于展示与匹配
    campus: '',
    campusOptions: constants.CAMPUS_OPTIONS,
    campusIndex: 0, // picker 当前选中下标（与 campus 保持同步，campus 为空时给 0）
    campusTip: constants.CAMPUS_TIP,
    // 学号说明（法律口径）：与协议 1.2 同一口径，来源是 constants.STUDENT_ID_TIP
    studentIdTip: constants.STUDENT_ID_TIP,
    studentId: '',
    isStudentIdBound: false, // 云端已有合法学号 -> 输入框禁用、不可修改
    avatarText: '?',
    resume: '',
    contact: '',
    isProfileReady: false, // 昵称 + 校区 + 联系方式 + 广工学号均合格才为 true
    // 仅 role === 'admin' 为 true：决定是否显示【进入管理后台】入口（真正的权限校验在 admin 云函数）
    isAdmin: false,
    // 【防连点】保存请求进行中：按钮 disabled + loading，请求结束（成功或失败）后自动恢复
    isSaving: false,
    // 消息中心红点：有未读个人通知，或最新公告比本地 lastReadMessageTime 新
    hasUnreadMessage: false,

    // ---- 账号信用（users.warningCount，只读展示）----
    warningCount: 0,
    creditGood: true,               // 0 次违规 = 信用良好（绿色），否则橙红警告
    creditText: buildCreditText(0), // 完整文案（含 emoji），wxml 直接渲染

    // ---- 收到的评价（reviews 集合，全部匿名） ----
    showReviewRate: false,                 // 总数 >= 3 才展示好评率，否则只显示「满意度统计中...（n/3 条）」
    reviewRateText: constants.formatReviewRateText(0, 0), // 「好评率 95%（共 20 条评价）」唯一文案来源
    reviewEmptyText: '还没有收到评价',
    reviews: []                            // [{ id, fromName: '某同学', content, contextSnapshot, ratingText, isGood, createTime }]
  },

  onShow: function () {
    this.refreshProfile();
    this.refreshMessageBadge();
  },

  /**
   * 消息红点：有未读个人通知 或 有比本地 lastReadMessageTime 更新的公告
   * 未登录 / message 云函数未部署一律按「无红点」处理（store 内部已兜底，不抛错）
   */
  refreshMessageBadge: async function () {
    if (!store.isLoggedIn()) {
      this.setData({ hasUnreadMessage: false });
      tabBadge.apply(false); // 底部「我的」Tab 同步收红点
      return;
    }
    // tabBadge.refresh 内部已兜底（查询失败按无红点），同时把红点落到「我的」Tab 上
    const hasUnread = await tabBadge.refresh();
    this.setData({ hasUnreadMessage: hasUnread });
  },

  /**
   * 资料只从云端读；拉不到就渲染空表单，绝不用本地假数据填充
   */
  refreshProfile: async function () {
    if (!store.isLoggedIn()) {
      this.setData({
        isLogin: false,
        nickname: '',
        campus: '',
        campusIndex: 0,
        studentId: '',
        isStudentIdBound: false,
        avatarText: '?',
        resume: '',
        contact: '',
        isProfileReady: false,
        isAdmin: false,
        hasUnreadMessage: false,
        warningCount: 0,
        creditGood: true,
        creditText: buildCreditText(0),
        showReviewRate: false,
        reviewRateText: constants.formatReviewRateText(0, 0),
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
    // 违规次数只读：缺失 / 脏数据一律按 0 次处理，不让页面出现 NaN
    const warningCount = Number(profile.warningCount) || 0;

    this.setData({
      isLogin: true,
      nickname: profile.nickname || '',
      // 校区：只可能是 CAMPUS_OPTIONS 里的值；历史脏数据 / 未选 -> 空串，picker 显示占位文案
      campus: isCampusValue(profile.campus) ? profile.campus : '',
      campusIndex: Math.max(0, constants.CAMPUS_OPTIONS.indexOf(profile.campus)),
      studentId: profile.studentId || '',
      // 云端已有合法学号即视为「已绑定」：输入框禁用，且与服务端的学号锁同一判定标准
      isStudentIdBound: STUDENT_ID_REGEX.test((profile.studentId || '').trim()),
      avatarText: (profile.nickname || '?').slice(0, 1),
      resume: profile.resume || '',
      contact: profile.contact || '',
      // 严格判定：昵称 + 联系方式 + 学号格式（与 guard / 发布 / 申请同一套规则）
      isProfileReady: store.isProfileReady(),
      // 管理员入口：role 由云端 users 集合提供，客户端只能读
      isAdmin: store.isAdmin(),
      // 账号信用：warningCount 同样来自云端 users（写入只走 admin 云函数 / 控制台）
      warningCount: warningCount,
      creditGood: warningCount <= 0,
      creditText: buildCreditText(warningCount)
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
          // 合作上下文快照（服务端提交时定死的「【分类-标题】」）：
          // 老数据没有这个字段 -> ''，wxml 用 wx:if 判空后整块不渲染，绝不出现 null / 空括号
          contextSnapshot: item.contextSnapshot || '',
          isGood: item.rating === 1,
          ratingText: item.rating === 1 ? '满意' : '不满意',
          createTime: formatReviewTime(item.createTime)
        };
      });

    this.setData({
      showReviewRate: showRate,
      // 好评率与评价次数统一成一句（与详情页发布者名片同一个函数，字段口径对齐）
      reviewRateText: constants.formatReviewRateText(total, stat.rate || 0),
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
      // 登录后立刻同步一次红点（否则要等下一次 onShow 才会亮）
      this.refreshMessageBadge();
      wx.showToast({
        title: store.isProfileReady() ? '登录成功' : '登录成功，请完善昵称、校区与联系方式',
        icon: 'none'
      });
    } catch (err) {
      wx.hideLoading();
      console.error('[profile] 登录失败：', err);
      // 【v1.6.0】注销 / 封禁账号会被 login 云函数拦下，直接用云端给的用户可读文案
      wx.showToast({
        title: (err && err.code === 'ACCOUNT_BLOCKED' && err.message) || '登录失败，请稍后重试',
        icon: 'none',
        duration: err && err.code === 'ACCOUNT_BLOCKED' ? 3000 : 1500
      });
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
        that.setData({ hasUnreadMessage: false });
        tabBadge.apply(false); // 退出登录后底部「我的」红点一并收掉
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

  // 校区 picker：value 是 CAMPUS_OPTIONS 的下标，存库的是中文校区名
  onCampusChange: function (e) {
    const index = Number(e.detail.value) || 0;
    const options = this.data.campusOptions || [];
    this.setData({
      campusIndex: index,
      campus: options[index] || ''
    });
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
    // 【防连点】上一笔保存还没返回就直接忽略后续点击（按钮同时是 disabled，这里是第二道兜底）
    if (this.data.isSaving) return;

    const nickname = (this.data.nickname || '').trim();
    if (!nickname) {
      wx.showToast({ title: '请先填写昵称', icon: 'none' });
      return;
    }

    // 校区：必选（v1.6.0）。picker 只能选 CAMPUS_OPTIONS，云端还有同样一道白名单校验
    const campus = (this.data.campus || '').trim();
    if (!campus) {
      wx.showToast({ title: constants.CAMPUS_REQUIRED_MESSAGE, icon: 'none' });
      return;
    }
    if (constants.CAMPUS_LIST.indexOf(campus) === -1) {
      wx.showToast({ title: constants.CAMPUS_INVALID_MESSAGE, icon: 'none' });
      return;
    }

    // 【第一道：前端轻量拦截】昵称 + 简历 + 联系方式 拼成全文做净化匹配
    // 命中直接 return，不发请求（省一次云函数调用，也给用户最快反馈）
    // 净化 = 小写 + 删空白 + 删全部标点 + 全角转半角 + 拼音兜底，拆字/插标点/换拼音都躲不过
    const violation = constants.checkTextViolation(
      buildProfileFullText(nickname, this.data.resume || '', this.data.contact || '')
    );
    if (!violation.pass) {
      wx.showToast({
        title: constants.violationMessage('保存', violation.word),
        icon: 'none',
        duration: 2500
      });
      return;
    }

    // 学号：必填 + 广工 10 位格式（云函数里还有同样一道，防绕过）
    const studentId = (this.data.studentId || '').trim();
    if (!studentId) {
      wx.showToast({ title: '请填写学号，仅用于账号唯一性校验', icon: 'none' });
      return;
    }
    if (!STUDENT_ID_REGEX.test(studentId)) {
      wx.showToast({ title: '请输入正确的广工学号', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '保存中...', mask: true });
    // 进入保存态：按钮立即置灰 + 转圈，直到请求真正结束才恢复（见 finally）
    this.setData({ isSaving: true });
    try {
      await store.saveProfile({
        nickname: nickname,
        campus: campus,
        studentId: studentId,
        resume: this.data.resume || '',
        contact: this.data.contact || ''
      });
      wx.hideLoading();
      await this.refreshProfile();

      // 保存成功只给一句确认，不再追加「可以去大厅发布了」这类引导文案
      wx.showToast({ title: '保存成功', icon: 'none', duration: 900 });
    } catch (err) {
      wx.hideLoading();
      console.error('[profile] 资料保存失败：', err);

      const code = err && err.code;
      if (code === 'NICKNAME_TAKEN') {
        // 【v1.8.0】昵称被其他同学占用：昵称是帖子里唯一可见的身份标识，必须唯一。
        // 只提示更换，绝不自作主张在昵称后加数字（那样会冒出一堆「小明111」，反而更难认）
        wx.showToast({
          title: (err && err.message) || '该昵称已被占用，请换一个吧',
          icon: 'none',
          duration: 2500
        });
      } else if (code === 'STUDENT_ID_TAKEN') {
        // 学号被他人占用：这是安全拦截，用弹窗而不是 toast
        wx.showModal({
          title: '学号已被绑定',
          content: '该学号已被绑定，请勿盗用他人学号',
          showCancel: false,
          confirmText: '我知道了'
        });
      } else if (code === 'STUDENT_ID_INVALID') {
        wx.showToast({ title: '学号格式不正确，请检查后重试', icon: 'none' });
      } else if (code === 'CAMPUS_INVALID' || code === 'CAMPUS_REQUIRED') {
        // 云端校区门禁（改包 / 旧版客户端才会走到这里）
        wx.showToast({
          title: (err && err.message) || constants.CAMPUS_INVALID_MESSAGE,
          icon: 'none'
        });
      } else if (code === 'CONTENT_RISKY') {
        // 【第二道：云端拦截】本地校验被绕过（改包 / 旧版本客户端）时走到这里，
        // 云端已按「保存失败：包含违规词汇【xxx】，请修改后重试。」下发，优先直接展示
        wx.showToast({
          title: (err && err.hitWord)
            ? constants.violationMessage('保存', err.hitWord)
            : ((err && err.message) || constants.violationMessage('保存', '')),
          icon: 'none',
          duration: 2500
        });
      } else {
        wx.showToast({
          title: (err && err.message) || '保存失败，请稍后重试',
          icon: 'none'
        });
      }
    } finally {
      // 无论成功 / 失败都要恢复按钮：否则用户会卡在「保存中」再也点不动
      this.setData({ isSaving: false });
    }
  },

  /**
   * 注销账号（v1.6.0 合规）：破坏性且不可恢复，必须二次确认。
   * 云端做的事：写黑名单 -> 删 users -> 帖子 status 改 deleted -> 级联清理申请/评价/通知。
   */
  handleDeleteAccount: function () {
    if (!this.data.isLogin) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }

    const that = this;
    wx.showModal({
      title: constants.DELETE_ACCOUNT_TITLE,
      content: constants.DELETE_ACCOUNT_CONTENT,
      confirmText: '确认注销',
      confirmColor: '#e53935',
      cancelText: '再想想',
      success: function (res) {
        if (!res.confirm) return;
        that.doDeleteAccount();
      }
    });
  },

  doDeleteAccount: async function () {
    wx.showLoading({ title: '注销中...', mask: true });

    try {
      await store.deleteAccount();
      wx.hideLoading();

      this.setData({ hasUnreadMessage: false });
      tabBadge.apply(false); // 底部「我的」红点收掉
      await this.refreshProfile();

      wx.showModal({
        title: '账号已注销',
        content: '你的资料与发布内容已清理。如需重新使用，请联系管理员邮箱 ' + constants.ADMIN_CONTACT_EMAIL,
        showCancel: false,
        confirmText: '我知道了'
      });
    } catch (err) {
      wx.hideLoading();
      console.error('[profile] 注销失败：', err);
      wx.showToast({
        title: (err && err.message) || '注销失败，请稍后重试',
        icon: 'none',
        duration: 2500
      });
    }
  },

  /**
   * 进入管理后台（仅管理员可见）
   * 页面自身还会再校验一次：万一是改包把按钮调出来，云函数也会直接回 FORBIDDEN
   */
  onAdminTap: function () {
    wx.navigateTo({
      url: '/pages/admin/admin',
      fail: function (err) {
        console.error('[admin] 打开管理后台失败：', err);
        wx.showToast({ title: '页面打开失败，请稍后重试', icon: 'none' });
      }
    });
  },

  /**
   * 进入消息中心（公告 + 个人通知）
   * 红点会在返回本页的 onShow 里重新查一次（公告本地时间已在消息页更新）
   */
  onMessageTap: function () {
    if (!this.data.isLogin) {
      wx.showToast({ title: '请先登录后查看通知', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url: '/pages/messages/messages',
      fail: function (err) {
        console.error('[messages] 打开消息中心失败：', err);
        wx.showToast({ title: '页面打开失败，请稍后重试', icon: 'none' });
      }
    });
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
          title: '页面打开失败，请稍后重试',
          icon: 'none'
        });
      }
    });
  }
});
