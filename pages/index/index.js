// pages/index/index.js
// 大厅界面

const store = require("../../utils/store");
const constants = require("../../utils/constants");

const CATEGORY_MAP = constants.CATEGORY_MAP;
const POST_STATUS_MAP = constants.POST_STATUS_MAP;

// 审核中卡片的内容掩码
const CONTENT_MASK = '*** *** ***';

Page({
  data: {
    postList: []
  },

  onShow: function () {
    // 从发布页 / 详情页返回时自动刷新
    this.refreshList();
  },

  refreshList: function () {
    // 本地缓存（含草稿）+ mockData，统一按发布时间倒序
    const heatOverrides = store.getHeatOverrides();
    const postList = store.getPosts()
      .map(item => this.formatPost(item, heatOverrides))
      .sort((a, b) => b.createTime - a.createTime);

    this.setData({
      postList: postList
    });
  },

  /**
   * 统一字段格式：只认 PRD 新字段（category / content / authorName / contact / status / heat）
   * 字段兜底：tags || []、heat || 0，防止渲染报错（PRD「六、数据兜底」）
   * status === 'auditing' 时描述区打码，contentText 直接给 WXML 用
   */
  formatPost: function (raw, heatOverrides) {
    const status = POST_STATUS_MAP[raw.status] ? raw.status : 'active';
    const isAuditing = status === 'auditing';

    // 热度：与详情页写入的本地覆盖值取较大者
    const baseHeat = typeof raw.heat === 'number' ? raw.heat : 0;
    const savedHeat = (heatOverrides || {})[raw.id];
    const heat = (typeof savedHeat === 'number' && savedHeat > baseHeat) ? savedHeat : baseHeat;

    return {
      id: raw.id,
      category: raw.category,
      categoryKey: CATEGORY_MAP[raw.category] ? raw.category : 'other',
      categoryText: CATEGORY_MAP[raw.category] || '其他',
      title: raw.title || '未命名寻呼',
      content: raw.content || '',
      contentText: isAuditing ? CONTENT_MASK : (raw.content || ''),
      tags: raw.tags || [],
      authorName: raw.authorName || '匿名同学',
      contact: raw.contact || '',
      status: status,
      statusKey: status,
      statusText: POST_STATUS_MAP[status],
      heat: heat,
      createTime: raw.createTime || 0,
      isAuditing: isAuditing
    };
  },

  /**
   * 卡片点击：先校验登录，再校验审核状态，都不拦才进详情
   */
  goToDetail: function (e) {
    const id = e.currentTarget.dataset.id;
    const status = e.currentTarget.dataset.status;

    // 1. 未登录拦截
    if (!store.isLoggedIn()) {
      wx.showToast({ title: '请先前往「我的」页面登录', icon: 'none' });
      return;
    }

    // 2. 审核中拦截
    if (status === 'auditing') {
      wx.showToast({ title: '该信息还在审核中，暂不可查看', icon: 'none' });
      return;
    }

    wx.navigateTo({
      url: "/pages/detail/detail?id=" + id
    });
  },

  goToPublish: function () {
    wx.navigateTo({
      url: '/pages/publish/publish'
    });
  }
});
