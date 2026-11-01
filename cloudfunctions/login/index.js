// cloudfunctions/login/index.js
// 作用：返回调用者的 openid。客户端拿不到 openid，必须由云函数下发。

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async () => {
  const ctx = cloud.getWXContext();
  return {
    openid: ctx.OPENID,
    appid: ctx.APPID,
    unionid: ctx.UNIONID || ''
  };
};
