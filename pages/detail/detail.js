// pages/detail/detail.js

Page({
  data: {
    projectId: null
  },

  // options 就是页面跳转传过来的参数对象
  onLoad: function(options){
    console.log("接收到的参数：",options);

    // 把拿到的 id 存进 data 里
    this.setData({
      projectId: options.id
    });
  }
});