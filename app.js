// app.js
// 云开发初始化 + 数据预热

const constants = require('./utils/constants');
const store = require('./utils/store');

App({
  globalData: {
    openid: '',
    cloudReady: false
  },

  onLaunch() {
    // 1. 云开发能力检测（基础库需 2.2.3+，本项目的 libVersion 为 trial，已满足）
    if (!wx.cloud) {
      console.error('[cloud] 当前基础库不支持云开发，请提升调试基础库版本');
      return;
    }

    // 2. 初始化云环境：env 取自 utils/constants.js 的 CLOUD_ENV
    try {
      wx.cloud.init({
        env: constants.CLOUD_ENV,
        traceUser: true // 在控制台「用户管理」记录访问用户
      });
    } catch (err) {
      // env 填错 / 未开通云开发，会在这一步或后续首次请求时报错
      console.error('[cloud] init 失败，请检查 CLOUD_ENV 与控制台是否已开通云开发', err);
      return;
    }
    this.globalData.cloudReady = true;

    // 3. 预热：取 openid + 拉 posts / applications（失败不阻塞页面，页面调用时会重试）
    const that = this;
    store.init()
      .then(function (state) {
        that.globalData.openid = state.openid;
        console.log('[cloud] 初始化完成', state);
      })
      .catch(function (err) {
        console.error('[cloud] 初始化失败，请检查环境 ID / 集合 / 云函数是否已部署', err);
      });
  }
});
