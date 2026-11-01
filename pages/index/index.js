// pages/index/index.js
// 大厅界面

const store = require("../../utils/store");
const guard = require("../../utils/guard");
const constants = require("../../utils/constants");

const CATEGORY_MAP = constants.CATEGORY_MAP;
const POST_STATUS_MAP = constants.POST_STATUS_MAP;

// 审核中卡片的内容掩码
const CONTENT_MASK = '*** *** ***';

Page({
  data: {
    postList: [],
    refreshing: false,
    loaded: false // 云数据首次拉取是否完成（避免空状态误闪）
  },

  onShow: function () {
    // Pull-based 刷新：只在 onShow 拉一次，不用任何定时轮询
    this.refreshList();
  },

  // 用户主动下拉刷新（index.json 已开 enablePullDownRefresh）
  onPullDownRefresh: async function () {
    await this.refreshList();
    wx.stopPullDownRefresh();
  },

  // scroll-view 自带的下拉刷新（大厅内容捧在 scroll-view 里，页面本体不滚动）
  onRefresherRefresh: async function () {
    this.setData({ refreshing: true });
    await this.refreshList();
    this.setData({ refreshing: false });
  },

  // 先从云端刷缓存，再用同步方法渲染（渲染逻辑与本地版一致）
  refreshList: async function () {
    try {
      await store.syncPosts();
      this.setData({
        postList: this.buildPostList(),
        loaded: true
      });
    } catch (err) {
      console.error('[index] 云数据拉取失败：', err);
      this.setData({ loaded: true });
      if (!this.hasShownLoadError) {
        this.hasShownLoadError = true;
        wx.showToast({ title: '云数据加载失败，请稍后重试', icon: 'none' });
      }
    }
  },

  // 云端缓存已排序，这里直接做字段格式化
  buildPostList: function () {
    return store.getPosts().map(item => this.formatPost(item));
  },

  /**
   * 统一字段格式：只认 PRD 新字段（category / content / authorName / contact / status / heat）
   * 字段兜底：tags || []、heat || 0，防止渲染报错（PRD「六、数据兜底」）
   * status === 'auditing' 时描述区打码，contentText 直接给 WXML 用
   */
  formatPost: function (raw) {
    const status = POST_STATUS_MAP[raw.status] ? raw.status : 'active';
    const isAuditing = status === 'auditing';

    // 热度：直接取云文档里的值（本地覆盖表已下线）
    const heat = store.resolveHeat(raw);

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
   * 卡片点击：双重校验 —— 先登录、再资料完善，都通过才看审核状态与详情
   * （登录不代表能使用：昵称/联系方式缺失时对方无法联系你，所以要在入口拦住）
   */
  goToDetail: function (e) {
    const id = e.currentTarget.dataset.id;
    const status = e.currentTarget.dataset.status;

    // 1 + 2. 未登录 / 资料未完善：(guard.ensureReady 内部已弹窗并引导去「我的」)
    if (!guard.ensureReady()) return;

    // 3. 审核中拦截
    if (status === 'auditing') {
      wx.showToast({ title: '该信息还在审核中，暂不可查看', icon: 'none' });
      return;
    }

    wx.navigateTo({
      url: "/pages/detail/detail?id=" + id
    });
  },

  goToPublish: function () {
    // 与点卡片完全同一套拦截：未登录 / 资料未完善 都不得进入发布页
    if (!guard.ensureReady()) return;

    wx.navigateTo({
      url: '/pages/publish/publish'
    });
  }
});
