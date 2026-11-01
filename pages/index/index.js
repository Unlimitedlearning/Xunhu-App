// pages/index/index.js
// 大厅界面

const mockData = require("../../utils/mockData");

// 分类字典：英文枚举 -> 中文（PRD「二、2 数据字典映射」）
const categoryMap = {
  'team': '组队',
  'resume': '自荐',
  'partner': '搭子'
};

// 状态标识字典：仅 auditing / ended 需要在卡片上展示
const statusMap = {
  'auditing': '审核中',
  'ended': '已结束'
};

Page({
  data: {
    postList: []
  },

  onLoad: function () {
    // 空着即可
  },

  onShow: function () {
    // 从发布页 / 详情页返回时自动刷新
    this.refreshList();
  },

  refreshList: function () {
    let cloudPosts = mockData.postList || [];
    let localPosts = wx.getStorageSync('local_posts') || [];
    // 详情页累计的热度（heat +1 / +5）存在这里，刷新时合并进来
    let heatOverrides = wx.getStorageSync('local_heat_overrides') || {};

    // 处理本地数据：过滤脏数据，是否草稿由 syncState 决定（见 formatPost）
    let localList = localPosts
      .filter(function (item) {
        return typeof item === 'object' && item !== null;
      })
      .map(item => this.formatPost(item, true, heatOverrides));

    // 处理云端数据：按发布时间倒序
    let cloudList = cloudPosts
      .map(item => this.formatPost(item, false, heatOverrides))
      .sort((a, b) => b.createTime - a.createTime);

    // 草稿排在最前面，方便看到没发出去的内容
    let allPosts = localList.concat(cloudList);

    console.log("当前渲染的数据：", allPosts);

    this.setData({
      postList: allPosts
    });
  },

  /**
   * 统一字段格式
   * 兼容 PRD 新字段（category / content / authorName）与旧缓存草稿（PostCategory / desc / author）
   * 字段兜底：tags || []、heat || 0，防止渲染报错（PRD「六、数据兜底」）
   * isLocal：数据来自本地缓存草稿箱；其中 syncState !== 'synced' 的才算「待同步」草稿
   */
  formatPost: function (raw, isLocal, heatOverrides) {
    let item = Object.assign({}, raw);
    let category = item.category || item.PostCategory || '';
    let isDraft = !!isLocal && item.syncState !== 'synced';
    let status = item.status || (isDraft ? 'auditing' : 'active');

    // 热度：与详情页写入的本地覆盖值取较大者
    let baseHeat = typeof item.heat === 'number' ? item.heat : 0;
    let savedHeat = (heatOverrides || {})[item.id || item._id];
    let heat = (typeof savedHeat === 'number' && savedHeat > baseHeat) ? savedHeat : baseHeat;

    return {
      id: item.id || item._id || '',
      category: category,
      categoryKey: categoryMap[category] ? category : 'other',
      categoryText: categoryMap[category] || '其他',
      title: item.title || '未命名寻呼',
      content: item.content || item.desc || '',
      tags: item.tags || [],
      authorName: item.authorName || item.author || (isDraft ? '我自己' : '匿名同学'),
      contact: item.contact || '',
      status: status,
      statusKey: isDraft ? 'draft' : (statusMap[status] ? status : ''),
      statusText: isDraft ? '待同步' : (statusMap[status] || ''),
      heat: heat,
      createTime: item.createTime || 0,
      isDraft: isDraft
    };
  },

  goToDetail: function (e) {
    const id = e.currentTarget.dataset.id;
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
