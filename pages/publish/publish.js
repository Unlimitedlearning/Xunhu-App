// pages/publish/publish.js
// 组队需求发布页

Page({
  data: {
    title: "",
    desc: "",
    skillStr: ""
  },

  // ✅ 新增：页面加载时，去本地缓存里找回没发出去的草稿
  onLoad: function () {
    let localPosts = wx.getStorageSync('local_posts') || [];
    
    // 找一找有没有状态是 pending（待同步）的草稿
    const draft = localPosts.find(item => item.status === 'pending');
    
    if (draft) {
      console.log("发现未上传的草稿，自动回填：", draft);
      this.setData({
        title: draft.title,
        desc: draft.desc,
        skillStr: draft.tags ? draft.tags.join(" ") : ""
      });
      
      wx.showToast({
        title: '已为您恢复上次草稿',
        icon: 'none'
      });
    }
  },

  submitPost: function () {
    if (!this.data.title || !this.data.desc) {
      wx.showToast({ title: '标题和描述不能为空', icon: 'none' });
      return;
    }

    const tags = this.data.skillStr.split(" ").filter(item => item !== "");
    
    // 1. 组装数据，加上一个本地生成的唯一 ID 和时间
    const newPost = {
      id: 'local_' + Date.now(), 
      title: this.data.title,
      desc: this.data.desc,
      tags: tags,
      author: "我自己", 
      status: 'pending', // pending 表示待同步
      createTime: new Date().getTime()
    };

    // 第一步：立刻存入本地缓存（护城河）
    let localPosts = wx.getStorageSync('local_posts') || [];
    
    // 🌟 优化：发布新内容前，先删掉之前旧的“待同步草稿”，保证本地只有 1 份最新草稿
    localPosts = localPosts.filter(item => item.status !== 'pending');
    
    localPosts.unshift(newPost); 
    wx.setStorageSync('local_posts', localPosts);
    
    console.log("已安全保存到本地，数据为：", newPost);
    wx.showToast({ title: '已保存至本地', icon: 'success' });

    // 清空输入框
    this.setData({ title: "", desc: "", skillStr: "" });

    // ==========================================
    // 第二步：尝试静默上传到云端
    // ==========================================
    this.uploadToCloud(newPost);
  },

  uploadToCloud: function (postData) {
    // 这里模拟网络请求（以后会换成真实的 wx.cloud.database().collection('posts').add）
    wx.showLoading({ title: '同步中...' });
    
    setTimeout(() => {
      // 模拟 80% 成功率（你可以自己改随机数）
      wx.hideLoading();
      const isSuccess = Math.random() > 0.5; 


      if (isSuccess) {
        // 上传成功：从本地草稿箱中删除
        let localPosts = wx.getStorageSync('local_posts') || [];
        localPosts = localPosts.filter(item => item.id !== postData.id);
        wx.setStorageSync('local_posts', localPosts);
        
        wx.showToast({ title: '发布成功', icon: 'success' });
      } else {
        // 上传失败：保留在草稿箱
        wx.showToast({ title: '网络不佳，已存草稿', icon: 'none' });
      }

      // 🌟 核心修改：无论成功还是失败，延迟 1 秒后都返回首页！
      setTimeout(() => { 
        wx.navigateBack(); 
      }, 1000);

    }, 1500); 
  },

});