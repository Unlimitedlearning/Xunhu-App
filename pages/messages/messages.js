// pages/messages/messages.js
// 消息中心：全体公告（置顶） + 个人系统通知（处罚 / 解绑等）。
//
// 【为什么全部走云函数】
//   messages / announcements 两个集合对客户端都是「所有用户不可读写」：
//     · 个人通知的归属判定必须在服务端，否则改包就能看别人的通知；
//     · 公告是全局数据，但没有「按人已读」，已读只是设备本地时间概念。
//   所以列表 / 标记已读都调用 cloudfunctions/message，页面本身不发任何数据库查询。
//
// 【已读口径】
//   · 个人通知：点一下未读卡片 -> 云函数把 isRead 置 true（落库，换设备也保持已读）；
//   · 全体公告：进入本页即把本地 lastReadMessageTime 推到当下，个人页红点随之消失。

const store = require('../../utils/store');
const constants = require('../../utils/constants');

function pad(value) {
  return value < 10 ? '0' + value : '' + value;
}

// 时间戳 -> MM-DD HH:mm（跨年时补年份，避免「去年 12-31」看起来像今年）
function formatTime(timestamp) {
  const value = Number(timestamp) || 0;
  if (!value) return '';
  const date = new Date(value);
  const now = new Date();
  const md = pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  const hm = pad(date.getHours()) + ':' + pad(date.getMinutes());
  return date.getFullYear() === now.getFullYear() ? md + ' ' + hm : date.getFullYear() + '-' + md;
}

Page({
  data: {
    loading: true,
    loaded: false,          // 至少完成过一次加载才显示空态，避免一闪而过的「暂无通知」
    error: '',
    items: [],              // 合并后的展示列表：公告在前（📢），个人通知在后
    announcementIcon: constants.ANNOUNCEMENT_ICON,
    emptyText: constants.MESSAGE_EMPTY_TEXT
  },

  // onShow 而不是 onLoad：从后台切回来时红点 / 已读状态可能已经变了
  onShow: function () {
    this.loadMessages();
  },

  onPullDownRefresh: async function () {
    try {
      await this.loadMessages();
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  loadMessages: async function () {
    if (!store.isLoggedIn()) {
      this.setData({
        loading: false,
        loaded: true,
        error: '请先在「我的」页面登录后查看通知'
      });
      return;
    }

    this.setData({ loading: true, error: '' });

    try {
      const result = await store.fetchMessageCenter();
      this.renderItems(result);

      // 进入即视为「公告已看」：本地时间戳推到当下（个人通知的已读仍以云端 isRead 为准）
      store.markMessagesSeen();

      this.setData({ loading: false, loaded: true });
    } catch (err) {
      console.error('[messages] 消息加载失败：', err);
      const message = err && err.code === 'FUNCTION_CALL_FAILED'
        ? 'message 云函数未部署，请先在开发者工具上传并部署'
        : ((err && err.message) || '消息加载失败，请下拉重试');
      this.setData({
        loading: false,
        loaded: true,
        error: message
      });
    }
  },

  /**
   * 合并展示：公告永远置顶，个人通知在后（各自都已按 createTime 倒序）
   * 公告补上 📢 图标与「全体公告」标签；个人通知用 isRead 控制未读圆点
   */
  renderItems: function (result) {
    const announcements = ((result && result.announcements) || []).map(function (item) {
      return {
        id: item.id,
        kind: 'announcement',
        title: item.title,
        content: item.content,
        icon: constants.ANNOUNCEMENT_ICON,
        isRead: true, // 公告没有按人已读
        timeText: formatTime(item.createTime)
      };
    });

    const messages = ((result && result.messages) || []).map(function (item) {
      return {
        id: item.id,
        kind: 'message',
        title: item.title,
        content: item.content,
        icon: '',
        isRead: !!item.isRead,
        timeText: formatTime(item.createTime)
      };
    });

    this.setData({ items: announcements.concat(messages) });
  },

  /**
   * 点击卡片：
   *   · 未读的个人通知 -> 调云函数置已读（只改这一条，不整页重拉）
   *   · 公告 / 已读通知 -> 不做任何事（内容本来就整段展示，没有二级页）
   */
  onItemTap: function (e) {
    const dataset = e.currentTarget.dataset;
    const id = dataset.id || '';
    const kind = dataset.kind || '';
    const isRead = dataset.isread === true || dataset.isread === 'true';

    if (kind !== 'message' || !id || isRead) return;
    this.markRead(id);
  },

  markRead: async function (messageId) {
    const items = this.data.items;
    const index = items.findIndex(function (item) {
      return item.kind === 'message' && item.id === messageId;
    });
    if (index < 0) return;

    try {
      await store.markMessageRead(messageId);
      const patch = {};
      patch['items[' + index + '].isRead'] = true;
      this.setData(patch);
      wx.showToast({ title: '已标记为已读', icon: 'none', duration: 1200 });
    } catch (err) {
      console.error('[messages] 标记已读失败：', err);
      wx.showToast({ title: '标记失败，请稍后重试', icon: 'none' });
    }
  }
});
