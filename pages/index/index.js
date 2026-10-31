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
    let cloudPosts = mockData.postList || [];
    let localPosts = wx.getStorageSync('local_posts') || [];
    
    const categoryMap = {
      'team': '组队',
      'resume': '自荐',
      'partner': '搭子'
    };

    // 处理云端数据
    let cloudPostsWithTag = cloudPosts.map(function(item) {
      let newItem = Object.assign({}, item);
      newItem.CategoryText = categoryMap[newItem.PostCategory] || '其他';
      return newItem;
    });

    // 处理本地数据
    let localPostsWithTag = localPosts.map(function(item) {
      if (typeof item !== 'object' || item === null) return null; 
      let newItem = Object.assign({}, item);
      newItem.isDraft = true;
      newItem.CategoryText = categoryMap[newItem.PostCategory] || '其他'; 
      return newItem;
    }).filter(item => item !== null);

    // 🌟 注意：allPosts 必须在这里定义！
    let allPosts = localPostsWithTag.concat(cloudPostsWithTag);
    
    // 🌟 调试代码必须放在定义之后！
    console.log("当前渲染的数据：", allPosts);

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