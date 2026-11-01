// cloudfunctions/heat/index.js
// 作用：帖子热度原子自增。
// 为什么必须走云函数：posts 权限是「所有用户可读、仅创建者可写」，
// 客户端改别人的帖子会被拒（-502003 database permission denied），而热度恰恰发生在别人的帖子上。
// 另外 _.inc 是原子操作，两个人同时浏览不会互相覆盖。

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const COLLECTION = 'posts';
const MAX_DELTA = 5; // 单次最多 +5，防止被构造请求刷热度

exports.main = async (event) => {
  const postId = event && event.postId;
  const delta = Number(event && event.delta);

  if (!postId || !Number.isFinite(delta) || delta === 0) {
    return { ok: false, message: 'postId / delta 不合法' };
  }
  if (Math.abs(delta) > MAX_DELTA) {
    return { ok: false, message: 'delta 超出单次上限' };
  }

  const db = cloud.database();
  const _ = db.command;

  try {
    const res = await db.collection(COLLECTION).doc(postId).update({
      data: { heat: _.inc(delta) }
    });

    return {
      ok: true,
      updated: res.stats && res.stats.updated,
      delta: delta
    };
  } catch (err) {
    return {
      ok: false,
      code: err && (err.errCode || err.code),
      message: err && err.message
    };
  }
};
