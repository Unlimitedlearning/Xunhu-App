// cloudfunctions/initDb/index.js
// 作用：创建 posts / post_contacts / applications / users / reports / reviews / admin_logs /
//       messages / announcements / blacklist 十个集合。
// 说明：客户端 SDK 没有 createCollection，只有服务端 SDK 有，所以必须放在云函数里跑一次。
// 用法：右键本文件夹 → 上传并部署（云端安装依赖）→ 云开发控制台「云函数 - initDb - 测试」直接运行。
//      安全规则不会自动建，建完集合还要去控制台给 post_contacts / applications / users /
//      reports / reviews / admin_logs / messages / announcements / blacklist **以及 posts**
//      全部设「所有用户不可读写」——posts 的读取也已经改走云函数 post（action: list / get），
//      客户端不需要任何数据库权限。

const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const COLLECTIONS = [
  'posts',
  'post_contacts', // v1.3.0：帖子联系方式（_id = postId），客户端零权限
  'applications',
  'users',
  'reports',
  'reviews',
  'admin_logs',
  'messages',      // v1.4.0：个人站内通知（_openid / toOpenid / type / title / content / isRead / createTime）
  'announcements', // v1.4.0：全体公告（title / content / createTime）
  'blacklist'      // v1.6.0：黑名单（openid / reason / source / createTime），客户端零权限
];

// 自检模式：客户端拉数据报 -502003 时调用，用服务端 SDK（不受安全规则限制）回报集合真实状态，
// 用来区分「安全规则/权限问题」和「集合不在这个环境里」。
// 用法：云函数控制台测试，入参 {"diagnose": true}
exports.main = async (event) => {
  const db = cloud.database();

  if (event && event.diagnose) {
    const ctx = cloud.getWXContext();
    const report = {
      env: process.env.TCB_ENV || process.env.SCF_NAMESPACE || 'unknown',
      appid: ctx.APPID,
      openid: ctx.OPENID,
      collections: {}
    };

    for (const name of COLLECTIONS) {
      try {
        const cnt = await db.collection(name).count();
        report.collections[name] = { exists: true, total: cnt.total };
      } catch (err) {
        report.collections[name] = {
          exists: false,
          code: (err && (err.errCode || err.code)) || '',
          message: err && err.message
        };
      }
    }

    return report;
  }

  const created = [];
  const existed = [];
  const failed = [];

  for (const name of COLLECTIONS) {
    try {
      await db.createCollection(name);
      created.push(name);
    } catch (err) {
      // -501001 / ResourceUnavailable 一般表示集合已存在，属于正常情况
      const code = err && (err.errCode || err.code);
      if (code === -501001 || String(err && err.message).indexOf('already exists') > -1) {
        existed.push(name);
      } else {
        failed.push({ name, code, message: err && err.message });
      }
    }
  }

  return { created, existed, failed };
};
