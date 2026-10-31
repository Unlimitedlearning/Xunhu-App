// pages/index/index.js
// 大厅界面

const mockData = require("../../utils/mockData");

Page({
  data: {
    postList: [] 
  },

  onLoad: function (){
    // 空着即可
  },

  onShow: function () {
    this.refreshList();
  },

  refreshList: function() {
    // 1. 获取云端假数据
    let cloudPosts = mockData.postList || [];
    
    // 2. 获取本地未上传的草稿数据
    let localPosts = wx.getStorageSync('local_posts') || [];
    
    // 3. 安全合并：判断如果是对象，才加上草稿标签
    let localPostsWithTag = localPosts.map(function(item) {
      // 防止缓存里出现奇怪的非对象数据导致报错
      if (typeof item !== 'object' || item === null) return null; 
      
      let newItem = Object.assign({}, item);
      newItem.isDraft = true;
      return newItem;
    }).filter(function(item) {
      return item !== null; // 过滤掉异常数据
    });

    // 4. 拼接数组
    let allPosts = localPostsWithTag.concat(cloudPosts);
    
    this.setData({
      postList: allPosts
    });
  },

  goToDetail: function(e){
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: "/pages/detail/detail?id=" + id
    });
  },

  goToPublish: function() {
    wx.navigateTo({
      url: '/pages/publish/publish'
    });
  }
});