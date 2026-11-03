// pages/agreement/agreement.js
// 协议页：纯文本静态展示，无任何数据读写（信任背书性质页面）
//
// 版本记录：
//   v1.3  2.1 补充「严禁填写虚假信息骗取他人信息」条款（配合详情页申请弹窗的警告）
//   v1.4  新增真实姓名背书（3.3）与站内通知 / 公告（3.4）
//   v1.5  【法律口径修订】清除「身份认证 / 官方认证 / 实名认证」等表述：
//         1.2 学号改为「账号唯一性校验 + 不接入学籍系统」
//         1.3 新增统一免责声明（constants.IDENTITY_DISCLAIMER，全站唯一来源）
//         3.3 真实姓名降级为「自我声明」，明确不保证姓名与本人一致
//         5.3 新增线下合作纠纷与损失的免责条款
const constants = require('../../utils/constants');

Page({
  data: {
    updateDate: '2026-11-03', // TODO 改为本次发版的真实日期
    version: 'v1.5',
    // 声明文案不在这里写死：协议页与个人页共用 constants.IDENTITY_DISCLAIMER，
    // 以后法律口径要调，只改 constants 一处，两个页面同时生效
    identityDisclaimer: constants.IDENTITY_DISCLAIMER
  }
});
