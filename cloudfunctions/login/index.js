// cloudfunctions/login/index.js
// 作用：返回调用者的 openid。客户端拿不到 openid，必须由云函数下发。
//
// 【v1.6.0 黑名单拦截】
//   注销账号 / 被封禁的 openid 会先被 blacklist 挡掉，不下发 openid。
//   为什么在 login 这一层拦：store.fetchOpenid() 是所有云调用的前置（拿不到 openid，
//   init 就失败，拉帖 / 拉资料 / 发布全都走不动），所以这里是最省事的统一入口。
//   返回结构保持字段不变（openid 置空 + code / message），老客户端也不会崩。
//
// 注意：blacklist 集合客户端零权限，只能由云函数 user（注销）与 admin（封禁）写入。

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const BLACKLIST = 'blacklist';
const BLACKLIST_MESSAGE = '该账号已注销或已被限制使用，如有疑问请联系管理员邮箱：xunhu_app@qq.com';

function isMissingCollection(err) {
  const code = String((err && (err.errCode || err.code)) || '');
  const message = String((err && err.message) || '');
  return code === '-502005' || message.indexOf('not exist') > -1 || message.indexOf('collection not exists') > -1;
}

// 黑名单查询：失败按「未命中」处理（fail-open）。
// 理由：注销时 users 记录已删除、封禁时 role 已置 banned，黑名单是第二道锁，
// 不应该因为集合还没建（-502005）就让所有人登录失败。
async function isBlacklisted(openid) {
  if (!openid) return false;
  const db = cloud.database();
  try {
    const res = await db.collection(BLACKLIST).where({ openid: openid }).limit(1).get();
    return !!((res && res.data) || []).length;
  } catch (err) {
    if (isMissingCollection(err)) return false;
    console.warn('[login] blacklist 查询失败，按未命中处理：', err && err.message);
    return false;
  }
}

exports.main = async () => {
  const ctx = cloud.getWXContext();
  const openid = ctx.OPENID || '';

  if (openid && await isBlacklisted(openid)) {
    console.warn('[login] 命中黑名单，拒绝下发 openid：', openid);
    return {
      openid: '',
      appid: ctx.APPID,
      unionid: '',
      code: 'ACCOUNT_BLOCKED',
      message: BLACKLIST_MESSAGE
    };
  }

  return {
    openid: openid,
    appid: ctx.APPID,
    unionid: ctx.UNIONID || ''
  };
};
