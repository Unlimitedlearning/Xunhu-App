// pages/detail/detail.js
// 详情页：读取帖子完整内容，处理「申请加入」与「举报」
// 数据源：云数据库（经 utils/store 的缓存层）

const store = require("../../utils/store");
const constants = require("../../utils/constants");

const CATEGORY_MAP = constants.CATEGORY_MAP;
const POST_STATUS_MAP = constants.POST_STATUS_MAP;
const REPORT_CATEGORIES = constants.REPORT_CATEGORIES;

Page({
  data: {
    post: null,
    category: '',
    categoryKey: '',
    categoryText: '',
    statusText: '',
    statusKey: '',
    isOwner: false,
    hasApplied: false,
    isEnded: false,
    appliedStatus: '',
    appliedText: '',
    notFound: false
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

    // 缓存里没有（冷启动 / 分享直达）→ 再拉一次
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

    // 状态限制：审核中的帖子只有发帖人本人能看（大厅已在入口拦截，这里再兜一层）
    if (post.status === 'auditing' && !isOwner) {
      wx.showToast({ title: '该信息还在审核中，暂不可查看', icon: 'none' });
      setTimeout(function () {
        wx.navigateBack();
      }, 1200);
      return;
    }

    // 热度防刷：同一用户对同一帖子、同一天只计一次浏览热度（云端原子自增）
    let heat = store.resolveHeat(post);
    if (store.claimHeatOnce(post.id, openid, store.HEAT_ACTION.VIEW)) {
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
      category: category,
      categoryKey: CATEGORY_MAP[category] ? category : 'other',
      categoryText: CATEGORY_MAP[category] || '其他',
      statusText: POST_STATUS_MAP[post.status],
      statusKey: post.status,
      isOwner: isOwner,
      hasApplied: hasApplied,
      isEnded: post.status === 'ended',
      appliedStatus: appliedStatus,
      appliedText: appliedText,
      notFound: false
    });
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

    // 0. 身份前提：展示名与联系方式都必须来自你自己在「我的」填的资料（云端 users 集合）
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

    // 1. 写入一条 pending 申请（带申请人自己填的联系方式 + 学号，仅 accepted 后对发帖人可见）
    const application = {
      postId: post.id,
      applicantId: openid,
      applicantName: nickname,
      applicantContact: applicantContact,
      applicantStudentId: (store.getProfile().studentId || '').trim(),
      receiverId: post.authorOpenid || post._openid || '',
      status: 'pending',
      createTime: Date.now()
    };

    try {
      await store.addApplication(application);
    } catch (err) {
      console.error('[detail] 申请写入失败：', err);
      wx.showToast({ title: '申请发送失败，请稍后重试', icon: 'none' });
      return;
    }

    // 2. 热度 +5：同一用户对同一帖子只贡献一次申请热度
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
   * 举报：ActionSheet 选分类 -> Modal 填描述 -> 存本地
   * 举报数据仍留在本机（未建 reports 集合），不接真实审核后台
   */
  onReportClick: function () {
    const that = this;
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
        that.saveReport(category, res.content || '');
        wx.showToast({ title: '举报成功，感谢反馈', icon: 'none' });
      }
    });
  },

  saveReport: function (category, description) {
    const post = this.data.post;
    store.addReport({
      id: 'report_' + Date.now(),
      postId: post ? post.id : '',
      reporterId: store.getOpenId(),
      category: category,
      description: (description || '').trim(),
      createTime: Date.now()
    });
  }
});
