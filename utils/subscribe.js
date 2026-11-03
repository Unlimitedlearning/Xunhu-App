// utils/subscribe.js
// 一次性订阅消息授权（v1.5.0）
//
// 设计原则（很重要，别改成「授权失败就 return」）：
//   订阅通知是**附加能力**，不是业务流程的一部分。
//   未配置模板 ID / 用户点「拒绝」/ 基础库过低 / 接口报错 —— 任何一种情况
//   都必须静默降级为 false，业务（提交申请 / 同意申请）照常往下走。
//   用户拒绝授权只是「收不到通知」，绝不能被卡在按钮上。
//
// 调用时机同样关键：
//   wx.requestSubscribeMessage 必须由用户点击触发。所以它要在点击处理函数的
//   **第一段同步代码里**发起（await 前后都可以，但发起时不能隔着别的异步操作），
//   否则微信会直接 fail（errCode 20004 / "can only be invoked by user TAP gesture"）。
//   细节见 pages/detail/detail.js 的 applyJoin 与 pages/task/task.js 的 handleApplication。
//
// 与云函数的关系：这里只负责「拿到授权」，真正发消息要靠服务端
//   cloud.openapi.subscribeMessage.send({ touser, template_id, page, data })
// 模板 ID 填好后还需要在 cloudfunctions/application 里补发送逻辑。

const constants = require('./constants');

// 微信一次性订阅的授权结果：'accept' / 'reject' / 'ban'（模板被封）/ 'filter'（被过滤）
const ACCEPT = 'accept';

/**
 * 请求一次订阅授权（永不抛错、永不阻塞业务）
 * @param {string} tmplId 模板 ID（为空表示还没去公众平台申请，直接跳过）
 * @param {string} scene 场景名，只用于日志，方便排障
 * @return {Promise<boolean>} true = 用户同意（后续能收到一条通知）；false = 没拿到授权
 */
function requestOne(tmplId, scene) {
  return new Promise(function (resolve) {
    const id = String(tmplId || '').trim();

    // 1) 模板 ID 还没填：静默跳过（内测期就是这个状态，业务完全不受影响）
    if (!id) {
      console.log('[subscribe] ' + scene + '：模板 ID 未配置，跳过订阅授权');
      resolve(false);
      return;
    }

    // 2) 基础库太低（requestSubscribeMessage 需要 2.4.4+）：跳过，不能让业务崩
    if (typeof wx.requestSubscribeMessage !== 'function') {
      console.warn('[subscribe] ' + scene + '：当前基础库不支持订阅消息，已跳过');
      resolve(false);
      return;
    }

    wx.requestSubscribeMessage({
      tmplIds: [id],
      success: function (res) {
        const state = res && res[id];
        const accepted = state === ACCEPT;
        console.log('[subscribe] ' + scene + '：授权结果=' + (state || '(空)') + ' accepted=' + accepted);
        // reject / ban / filter 一律当 false，调用方照常继续
        resolve(accepted);
      },
      fail: function (err) {
        // 常见：errCode 20004（非点击触发）/ 10005（模板 ID 不存在）/ 用户从未订阅过
        console.warn('[subscribe] ' + scene + '：授权失败 code=' +
          ((err && err.errCode) || (err && err.code) || '') + '，按未授权继续');
        resolve(false);
      }
    });
  });
}

/**
 * 申请人点「提交申请」时调用（模板：TMPL_APPLY_ID）
 * 语义：申请人订阅「我的申请有结果了」这条通知，发给他自己。
 * @return {Promise<boolean>}
 */
function requestApplySubscribe() {
  return requestOne(constants.TMPL_APPLY_ID, 'apply');
}

/**
 * 发帖人点「同意申请」时调用（模板：TMPL_ACCEPT_ID）
 * 语义：发帖人订阅「有新申请 / 状态提醒」这条通知，发给他自己。
 * @return {Promise<boolean>}
 */
function requestAcceptSubscribe() {
  return requestOne(constants.TMPL_ACCEPT_ID, 'accept');
}

module.exports = {
  requestOne,
  requestApplySubscribe,
  requestAcceptSubscribe
};
