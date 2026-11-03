// pages/index/index.js
// 大厅界面：三个 Tab（最新发布 / 最热招募 / 往期历史）都是纯前端内存处理
//   数据只拉一次（onShow 一次 + 下拉刷新一次），切 Tab 只做 filter + sort，不重新请求网络
//   动态热门标签（hotTags）同样是纯内存聚合：基于「当前 Tab 的帖子」实时统计频次，取前 8 个
//   标签筛选叠加在 Tab 结果之上（先 Tab 后标签），全程零网络请求、零数据库查询

const store = require("../../utils/store");
const guard = require("../../utils/guard");
const constants = require("../../utils/constants");
const tabBadge = require("../../utils/tabBadge");

const CATEGORY_MAP = constants.CATEGORY_MAP;
const POST_STATUS_MAP = constants.POST_STATUS_MAP;
const ACTIVE_POST_LIMIT_MESSAGE = constants.ACTIVE_POST_LIMIT_MESSAGE;
const AUDITING_BLOCK_MESSAGE = constants.AUDITING_BLOCK_MESSAGE;

// 审核中卡片的内容掩码
const CONTENT_MASK = '*** *** ***';

// 大厅允许展示的状态（口径「四、帖子状态机」）：
//   active 正常展示 / auditing 打码展示 / ended 仅往期历史
//   deleted（违规下架）与 unknown（拼错或未来新增的状态）一律不进列表 —— 宁可少显示，绝不误放
const VISIBLE_STATUS = ['active', 'auditing', 'ended'];

// 大厅 Tab（key 同时是 applyTab 的分支依据）
const TABS = [
  { key: 'latest', text: '最新发布' },
  { key: 'hot', text: '最热招募' },
  { key: 'history', text: '往期历史' }
];

// 热门标签最多展示个数（不足 8 个就有几个显示几个）
const HOT_TAG_LIMIT = 8;

// 标签筛选后一条都没命中时的空状态前缀（后面拼上标签名）
const TAG_EMPTY_PREFIX = '没有找到包含「#';

// 新生引导：本地缓存 key（写过一次就再也不弹）
const GUIDE_STORAGE_KEY = 'hasSeenGuide_v1';

// 新生引导的四个卖点（重点区别于普通微信群：信任 + 保障）
const GUIDE_POINTS = [
  { emoji: '🎓', title: '校内互助', desc: '学号格式校验，共建校园专属圈子' },
  { emoji: '🤝', title: '双向互评', desc: '合作结束互相评价，留下真实信用记录' },
  { emoji: '🛡️', title: '隐私保护', desc: '双方同意后才展示联系方式，避免骚扰' },
  { emoji: '🚀', title: '快速发起', desc: '点击右下角 + 号发布招募，寻找你的队友' }
];

/**
 * 标签归一化：统一成「去空白的字符串数组」并去重
 * 热门标签统计（可按标签名做 key）和标签筛选（indexOf 精确匹配）都依赖这份干净数据，
 * 否则云端 tags 里一个前后空格就会导致「统计得到 A、筛选筛不出 A」。
 */
function normalizeTags(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const result = [];
  list.forEach(function (tag) {
    if (typeof tag !== 'string') return;
    const name = tag.trim();
    if (name && result.indexOf(name) === -1) result.push(name);
  });
  return result;
}

// 每个 Tab 的空状态文案（往期历史为空和「大厅为空」不是一回事）
const EMPTY_TEXT = {
  latest: '大厅目前空空如也，点击右下角 + 号，发布第一条招募吧！',
  hot: '暂时还没有招募热度，先去发一条吧！',
  history: '还没有已结束的信息，结束后会自动归档到这里。'
};

Page({
  data: {
    tabs: TABS,
    activeTab: 'latest',   // 默认「最新发布」
    activeTag: '',         // 当前选中的热门标签，空字符串 = 「全部」
    hotTags: [],           // 当前 Tab 下频次最高的前 8 个标签 [{ name, count }]
    postList: [],          // 当前 Tab + 标签筛选后真正渲染的列表
    emptyText: EMPTY_TEXT.latest,
    refreshing: false,
    loaded: false,         // 云数据首次拉取是否完成（避免空状态误闪）
    // ---- 新生一次性引导 ----
    showGuide: false,      // 首次进大厅弹自定义遮罩，点「我知道了」后本地缓存置 true
    guidePoints: GUIDE_POINTS
  },

  // 未进 data 的页面级字段：全部帖子的格式化结果（Tab 切换的唯一数据源）
  postPool: [],

  onShow: function () {
    // 0) 底部「我的」红点全局强提醒：有未读通知 / 新公告时亮红点
    //    （TabBar 页面上调用才生效；失败 / 未登录 / 云函数未部署都静默降级，不影响下面渲染）
    tabBadge.refresh();
    // 1) 新生引导：只有没看过的新设备才弹（缓存命中直接跳过）
    this.checkGuide();
    // 2) 缓存先行（秒开）：同步读本地快照 -> setData，第一帧就有内容，不白屏
    this.renderCachedList();
    // 3) 再静默拉云端：拿到新数据后覆盖快照并重新渲染（失败也不影响上面已渲染的缓存）
    this.refreshList();
  },

  /**
   * 新生一次性引导：没写过 GUIDE_STORAGE_KEY 才弹
   * guideDismissed 是页面级内存标记：即使 Storage 写入失败，本次会话也不会反复弹
   */
  checkGuide: function () {
    if (this.data.showGuide || this.guideDismissed) return;

    let seen = false;
    try {
      seen = wx.getStorageSync(GUIDE_STORAGE_KEY) === true;
    } catch (err) {
      console.warn('[index] 引导缓存读取失败，本次按未看过处理：', err);
    }
    if (seen) return;

    this.setData({ showGuide: true });
  },

  // 「我知道了，开启寻呼」：落缓存 + 关弹窗，以后绝不再弹
  onCloseGuide: function () {
    this.guideDismissed = true;
    this.setData({ showGuide: false });
    try {
      wx.setStorageSync(GUIDE_STORAGE_KEY, true);
    } catch (err) {
      console.error('[index] 引导已读标记写入失败：', err);
    }
  },

  // 空实现：给遮罩层的 catchtouchmove 用，阻断滑动穿透
  noop: function () {},

  /**
   * 缓存先行：本地快照 -> postPool -> 立即渲染（幂等，只在会话内首次执行）
   * 为什么不能每次 onShow 都用快照：从详情页返回时屏幕上已经是新数据，用快照反而会闪一下旧状态
   */
  renderCachedList: function () {
    if (this.postPool && this.postPool.length) return;

    const cached = store.hydrateFromCache();
    if (!cached.posts) return; // 首次安装 / 清理过缓存：等 refreshList 吧

    this.postPool = store.getPosts().map(item => this.formatPost(item));
    this.setData({ loaded: true });
    this.applyTab(this.data.activeTab);
  },

  // 用户主动下拉刷新（index.json 已开 enablePullDownRefresh）：跳过缓存，直接拉云端
  onPullDownRefresh: async function () {
    await this.refreshList();
    wx.stopPullDownRefresh();
  },

  // scroll-view 自带的下拉刷新（大厅内容捧在 scroll-view 里，页面本体不滚动）：同样跳过缓存
  onRefresherRefresh: async function () {
    this.setData({ refreshing: true });
    await this.refreshList();
    this.setData({ refreshing: false });
  },

  /**
   * 全量拉取（唯一的网络请求点，不读本地快照 —— 下拉刷新因此天然跳过缓存）：
   * 先把云端刷入缓存 -> 一次性格式化成 postPool -> 再按当前 Tab 做内存筛选
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
   * 切换 Tab / 点标签的统一入口：纯内存 filter + sort，零网络请求
   *   最新发布：status !== 'ended'，createTime 降序
   *   最热招募：status !== 'ended'，heat 降序
   *   往期历史：status === 'ended'，endTime 降序
   *
   * 处理链路：全量池 -> 丢掉 deleted/unknown -> Tab 细分（tabList）
   *          -> 统计热门标签（hotTags）-> 标签筛选（postList）
   * 注意 hotTags 是基于 tabList 统计的，不能基于 postList：
   *   否则点一个标签后标签栏会塌缩成只剩它自己，用户再也没法换回别的标签。
   *
   * @param {string} tabKey 目标 Tab
   * @param {string} [tag] 目标标签；不传 = 沿用当前 activeTag，传 '' = 回到「全部」
   */
  applyTab: function (tabKey, tag) {
    // deleted / unknown 在进入任何 Tab 之前就丢掉（下面三处 filter 只负责 active/auditing/ended 的细分）
    const pool = (this.postPool || []).filter(function (item) {
      return VISIBLE_STATUS.indexOf(item.status) > -1;
    });
    let tabList;

    if (tabKey === 'history') {
      tabList = pool
        .filter(function (item) { return item.status === 'ended'; })
        .sort(function (a, b) {
          // 老数据可能没有 endTime（被举报后直接归档等），用 createTime 兜底
          return (b.endTime || 0) - (a.endTime || 0) || (b.createTime || 0) - (a.createTime || 0);
        });
    } else if (tabKey === 'hot') {
      tabList = pool
        .filter(function (item) { return item.status !== 'ended'; })
        .sort(function (a, b) {
          return (b.heat || 0) - (a.heat || 0) || (b.createTime || 0) - (a.createTime || 0);
        });
    } else {
      tabList = pool
        .filter(function (item) { return item.status !== 'ended'; })
        .sort(function (a, b) { return (b.createTime || 0) - (a.createTime || 0); });
    }

    // 任务一：热门标签永远跟着「当前 Tab 的数据」重算（切 Tab、下拉刷新都会走到这里）
    const hotTags = this.collectHotTags(tabList);

    // 切 Tab 时如果选中的标签在新 Tab 里连前 8 都没进（等于筛不出东西也没高亮可点），自动回到「全部」
    let activeTag = (tag === undefined) ? (this.data.activeTag || '') : (tag || '');
    if (activeTag && !this.hasTag(hotTags, activeTag)) activeTag = '';

    // 任务三：标签筛选叠加在 Tab 结果之上 —— 先 Tab 后标签，两者互不越界
    // （在「往期历史」里点标签，只会在历史帖子里筛，不会翻出进行中的帖子）
    const postList = activeTag
      ? tabList.filter(function (item) {
          return (item.tags || []).indexOf(activeTag) > -1;
        })
      : tabList;

    this.setData({
      activeTab: tabKey,
      activeTag: activeTag,
      hotTags: hotTags,
      postList: postList,
      emptyText: activeTag
        ? TAG_EMPTY_PREFIX + activeTag + '」的信息，换个标签试试吧'
        : (EMPTY_TEXT[tabKey] || EMPTY_TEXT.latest)
    });
  },

  /**
   * 任务一：动态热门标签聚合
   * 遍历传入列表的所有 tags，统计每个标签出现次数，频次降序取前 HOT_TAG_LIMIT 个。
   * 同频次时按「首次出现的先后」排，保证每次渲染顺序稳定（不来回跳）。
   * @param {Array} list 当前 Tab 的帖子
   * @returns {Array<{name: string, count: number}>}
   */
  collectHotTags: function (list) {
    const counter = Object.create(null);
    const firstSeen = Object.create(null);
    let seq = 0;

    (list || []).forEach(function (item) {
      (item.tags || []).forEach(function (name) {
        if (counter[name] === undefined) {
          counter[name] = 0;
          firstSeen[name] = seq++;
        }
        counter[name] += 1;
      });
    });

    return Object.keys(counter)
      .sort(function (a, b) {
        return counter[b] - counter[a] || firstSeen[a] - firstSeen[b];
      })
      .slice(0, HOT_TAG_LIMIT)
      .map(function (name) {
        return { name: name, count: counter[name] };
      });
  },

  // 当前 activeTag 是否还在热门标签里（决定切 Tab 后要不要自动取消选中）
  hasTag: function (hotTags, tag) {
    return (hotTags || []).some(function (item) { return item.name === tag; });
  },

  // Tab 点击：只改选中态 + 重算列表，不请求网络
  onTabChange: function (e) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab || tab === this.data.activeTab) return;
    this.applyTab(tab);
  },

  /**
   * 任务三：热门标签点击
   *   点未选中的标签 -> 选中，只显示含该标签的帖子
   *   再点同一个 / 点「全部」-> 取消选中，恢复当前 Tab 的完整列表
   */
  onTagTap: function (e) {
    // dataset 强转字符串：「全部」按钮的 data-tag 是空串，避免个别基础库把它解析成 true / undefined
    const rawTag = e.currentTarget.dataset.tag;
    const tag = (typeof rawTag === 'string') ? rawTag.trim() : '';
    const next = (tag && tag !== this.data.activeTag) ? tag : '';
    if (next === (this.data.activeTag || '')) return; // 重复点「全部」不做无谓 setData
    this.applyTab(this.data.activeTab, next);
  },

  /**
   * 统一字段格式：只认 PRD 新字段（category / content / authorName / status / heat）
   * 字段兜底：tags || []、heat || 0，防止渲染报错（PRD「六、数据兜底」）
   * status === 'auditing' 时描述区打码，contentText 直接给 WXML 用
   * 【v1.3.0】不再输出 contact：联系方式已从 posts 迁到 post_contacts（客户端零权限），
   *   大厅卡片本来也不展示它，没必要把写进 postPool / data。
   */
  formatPost: function (raw) {
    // 状态兜底分三种，绝不把未知状态当成 active（否则 deleted / 拼错状态会以「进行中」出现且可点入）：
    //   1) 字段缺失（老文档）  -> 'active'，仅兜底渲染，不能白屏
    //   2) 白名单内（含 deleted） -> 原值，deleted 会被 applyTab 过滤掉
    //   3) 其余（拼错 / 未来新增） -> 'unknown'，同样会被过滤掉
    let status;
    if (!raw.status) status = 'active';
    else if (VISIBLE_STATUS.indexOf(raw.status) > -1 || raw.status === 'deleted') status = raw.status;
    else status = 'unknown';
    const isAuditing = status === 'auditing';

    // 热度：直接取云文档里的值（本地覆盖表已下线）
    const heat = store.resolveHeat(raw);

    return {
      id: raw.id,
      category: raw.category,
      categoryKey: CATEGORY_MAP[raw.category] ? raw.category : 'other',
      categoryText: CATEGORY_MAP[raw.category] || '其他',
      title: raw.title || '未命名信息',
      content: raw.content || '',
      contentText: isAuditing ? CONTENT_MASK : (raw.content || ''),
      tags: normalizeTags(raw.tags),
      authorName: raw.authorName || '匿名同学',
      authorOpenid: raw.authorOpenid || '', // 用于判断「这是不是我自己的帖子」（审查中放行作者本人）
      status: status,
      statusKey: status,
      statusText: POST_STATUS_MAP[status] || '',
      heat: heat,
      createTime: raw.createTime || 0,
      endTime: raw.endTime || 0, // 「往期历史」按它降序
      isAuditing: isAuditing
    };
  },

  /**
   * 卡片点击：先看是不是受罚者，再看是不是审查中（打码），再校验登录 / 资料完善，都过了才跳详情
   * （登录不代表能使用：昵称/联系方式缺失时对方无法联系你，所以要在入口拦住）
   */
  goToDetail: function (e) {
    const id = e.currentTarget.dataset.id;
    const status = e.currentTarget.dataset.status;
    const authorOpenid = e.currentTarget.dataset.author || '';

    // 1. 受罚者（role === 'banned'）：口径「受罚者不可进入详情页」，最先拦
    if (guard.isBanned()) {
      guard.promptBanned();
      return;
    }

    // 2. 审查中（被举报打码 / 机审待复核）：作者本人放行，其他人拦截
    //    口径「四、帖子状态机」：发布者可以进入详情查看；其他用户点击时被拦截
    //    放在登录/资料校验之前，否则未登录用户只会看到「请先登录」，反而不知道内容有问题
    if (status === 'auditing') {
      const myOpenid = store.getOpenId();
      const isAuthor = !!myOpenid && !!authorOpenid && authorOpenid === myOpenid;
      if (!isAuthor) {
        wx.showToast({
          title: AUDITING_BLOCK_MESSAGE, // '该内容涉嫌违规，正在审查中'
          icon: 'none',
          duration: 1800
        });
        return;
      }
    }

    // 3 + 4. 未登录 / 受罚者 / 资料未完善：(guard.ensureReady 内部已弹窗并引导去「我的」)
    if (!guard.ensureReady()) return;

    wx.navigateTo({
      url: "/pages/detail/detail?id=" + id
    });
  },

  /**
   * 发布入口（+ 号）
   * 拦截顺序：受罚者 -> 登录/资料 -> 一人一帖（active / auditing 都占名额，只能有一条）
   * 一人一帖判定优先读内存缓存；首次进入列表还没拉完（loaded=false）时补一次同步，避免误放行
   */
  goToPublish: async function () {
    // 与点卡片完全同一套拦截：受罚者 / 未登录 / 资料未完善 都不得进入发布页
    if (guard.isBanned()) {
      guard.promptBanned();
      return;
    }
    if (!guard.ensureReady()) return;

    let activeMine = store.findMyActivePost();
    if (!activeMine && !this.data.loaded) {
      try {
        await store.syncPosts();
      } catch (err) {
        console.warn('[index] 发布前查重时拉取帖子失败，按「无占用名额的帖子」放行：', err);
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
