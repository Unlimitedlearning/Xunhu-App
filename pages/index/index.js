// pages/index/index.js
// 大厅界面：三个 Tab（最新发布 / 最热招募 / 往期历史）都是纯前端内存处理
//   数据只拉一次（onShow 一次 + 下拉刷新一次），切 Tab 只做 filter + sort，不重新请求网络

const store = require("../../utils/store");
const guard = require("../../utils/guard");
const constants = require("../../utils/constants");

const CATEGORY_MAP = constants.CATEGORY_MAP;
const POST_STATUS_MAP = constants.POST_STATUS_MAP;
const ACTIVE_POST_LIMIT_MESSAGE = constants.ACTIVE_POST_LIMIT_MESSAGE;

// 审核中卡片的内容掩码
const CONTENT_MASK = '*** *** ***';

// 大厅 Tab（key 同时是 applyTab 的分支依据）
const TABS = [
  { key: 'latest', text: '最新发布' },
  { key: 'hot', text: '最热招募' },
  { key: 'history', text: '往期历史' }
];

// 每个 Tab 的空状态文案（往期历史为空和「大厅为空」不是一回事）
const EMPTY_TEXT = {
  latest: '大厅目前空空如也，点击右下角 + 号，发布第一条招募吧！',
  hot: '暂时还没有招募热度，先去发一条吧！',
  history: '还没有已结束的寻呼，结束后会自动归档到这里。'
};

Page({
  data: {
    tabs: TABS,
    activeTab: 'latest',   // 默认「最新发布」
    postList: [],          // 当前 Tab 渲染的列表
    emptyText: EMPTY_TEXT.latest,
    refreshing: false,
    loaded: false          // 云数据首次拉取是否完成（避免空状态误闪）
  },

  // 未进 data 的页面级字段：全部帖子的格式化结果（Tab 切换的唯一数据源）
  postPool: [],

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

  /**
   * 全量拉取（唯一的网络请求点）：
   * 先把云端刷进缓存 -> 一次性格式化成 postPool -> 再按当前 Tab 做内存筛选
   */
  refreshList: async function () {
    try {
      await store.syncPosts();
      this.postPool = store.getPosts().map(item => this.formatPost(item));
      this.setData({ loaded: true });
      this.applyTab(this.data.activeTab);
    } catch (err) {
      console.error('[index] 云数据拉取失败：', err);
      this.setData({ loaded: true });
      // 拉取失败也把现有缓存（可能为空）渲染出来，不要停在「加载中」
      this.applyTab(this.data.activeTab);
      if (!this.hasShownLoadError) {
        this.hasShownLoadError = true;
        wx.showToast({ title: '云数据加载失败，请稍后重试', icon: 'none' });
      }
    }
  },

  /**
   * 切换 Tab：纯内存 filter + sort，零网络请求
   *   最新发布：status !== 'ended'，createTime 降序
   *   最热招募：status !== 'ended'，heat 降序
   *   往期历史：status === 'ended'，endTime 降序
   */
  applyTab: function (tabKey) {
    const pool = this.postPool || [];
    let list;

    if (tabKey === 'history') {
      list = pool
        .filter(function (item) { return item.status === 'ended'; })
        .sort(function (a, b) {
          // 老数据可能没有 endTime（被举报后直接归档等），用 createTime 兜底
          return (b.endTime || 0) - (a.endTime || 0) || (b.createTime || 0) - (a.createTime || 0);
        });
    } else if (tabKey === 'hot') {
      list = pool
        .filter(function (item) { return item.status !== 'ended'; })
        .sort(function (a, b) {
          return (b.heat || 0) - (a.heat || 0) || (b.createTime || 0) - (a.createTime || 0);
        });
    } else {
      list = pool
        .filter(function (item) { return item.status !== 'ended'; })
        .sort(function (a, b) { return (b.createTime || 0) - (a.createTime || 0); });
    }

    this.setData({
      activeTab: tabKey,
      postList: list,
      emptyText: EMPTY_TEXT[tabKey] || EMPTY_TEXT.latest
    });
  },

  // Tab 点击：只改选中态 + 重算列表，不请求网络
  onTabChange: function (e) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab || tab === this.data.activeTab) return;
    this.applyTab(tab);
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
      endTime: raw.endTime || 0, // 「往期历史」按它降序
      isAuditing: isAuditing
    };
  },

  /**
   * 卡片点击：先看是不是审查中（打码），再校验登录 / 资料完善，都过了才跳详情
   * （登录不代表能使用：昵称/联系方式缺失时对方无法联系你，所以要在入口拦住）
   */
  goToDetail: function (e) {
    const id = e.currentTarget.dataset.id;
    const status = e.currentTarget.dataset.status;

    // 1. 审查中（被举报打码 / 机审待复核）拦截跳转：
    //    先于登录/资料校验，否则未登录用户点卡片只会看到「请先登录」，反而不知道内容有问题
    if (status === 'auditing') {
      wx.showToast({
        title: constants.AUDITING_BLOCK_MESSAGE, // '该内容涉嫌违规，正在审查中'
        icon: 'none',
        duration: 1800
      });
      return;
    }

    // 2 + 3. 未登录 / 资料未完善：(guard.ensureReady 内部已弹窗并引导去「我的」)
    if (!guard.ensureReady()) return;

    wx.navigateTo({
      url: "/pages/detail/detail?id=" + id
    });
  },

  /**
   * 发布入口（+ 号）
   * 拦截顺序：登录/资料 -> 一人一帖（status === 'active' 的帖子只能有一条）
   * 一人一帖判定优先读内存缓存；首次进入列表还没拉完（loaded=false）时补一次同步，避免误放行
   */
  goToPublish: async function () {
    // 与点卡片完全同一套拦截：未登录 / 资料未完善 都不得进入发布页
    if (!guard.ensureReady()) return;

    let activeMine = store.findMyActivePost();
    if (!activeMine && !this.data.loaded) {
      try {
        await store.syncPosts();
      } catch (err) {
        console.warn('[index] 发布前查重时拉取帖子失败，按「无 active 帖子」放行：', err);
      }
      activeMine = store.findMyActivePost();
    }

    if (activeMine) {
      wx.showModal({
        title: '暂时不能发布',
        content: ACTIVE_POST_LIMIT_MESSAGE,
        showCancel: false,
        confirmText: '我知道了'
      });
      return;
    }

    wx.navigateTo({
      url: '/pages/publish/publish'
    });
  }
});
