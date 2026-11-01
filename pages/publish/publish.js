// pages/publish/publish.js
// 发布页：只做校验 + 落地本地缓存，不连真实云端

// 写死的当前登录用户（演示用，接入云开发后替换为真实 openid）
// 选「林同学」是因为 mockApplications 里他既有一条已同意的申请（能看到联系方式），
// 又收到一条待处理申请（能演示同意/拒绝），两个 Tab 都有真实数据可看。
const CURRENT_USER = {
  name: '林同学',
  openid: 'openid_mock_lin'
};

// PRD「六、安全拦截」违禁词
const FORBIDDEN_WORDS = ['代课', '代考', '代写', '刷单'];

Page({
  data: {
    categories: ['组队', '自荐', '搭子'],
    categoryKeys: ['team', 'resume', 'partner'], // 对应数据模型里的 category 枚举
    categoryIndex: 0,
    title: '',
    content: '',
    tagStr: '',
    contact: ''
  },

  onLoad: function () {
    // 离线优先：找回上次没同步成功的草稿（syncState !== 'synced'，旧版草稿无该字段同样算草稿）
    const localPosts = wx.getStorageSync('local_posts') || [];
    const draft = localPosts.find(item => item && item.syncState !== 'synced');

    if (!draft) return;

    const category = draft.category || draft.PostCategory || 'team';
    const index = this.data.categoryKeys.indexOf(category);

    this.setData({
      categoryIndex: index > -1 ? index : 0,
      title: draft.title || '',
      content: draft.content || draft.desc || '',
      tagStr: (draft.tags || []).join(' '),
      contact: draft.contact || ''
    });

    wx.showToast({
      title: '已为您恢复上次草稿',
      icon: 'none'
    });
  },

  onCategoryChange: function (e) {
    this.setData({
      categoryIndex: Number(e.detail.value)
    });
  },

  submitPost: function () {
    const title = (this.data.title || '').trim();
    const content = (this.data.content || '').trim();
    const contact = (this.data.contact || '').trim();
    const category = this.data.categoryKeys[this.data.categoryIndex];

    // 1. 必填项校验
    if (!title || !content || !contact) {
      wx.showToast({ title: '标题、描述、联系方式均不能为空', icon: 'none' });
      return;
    }

    // 2. 违禁词拦截（标题 + 描述）
    const hitWord = FORBIDDEN_WORDS.find(function (word) {
      return title.indexOf(word) > -1 || content.indexOf(word) > -1;
    });
    if (hitWord) {
      wx.showToast({ title: '内容含违规词「' + hitWord + '」，请修改后重试', icon: 'none' });
      return;
    }

    // 3. 标签：空格分隔，最多 4 个（PRD 数据模型）
    const tags = (this.data.tagStr || '')
      .split(' ')
      .map(item => item.trim())
      .filter(item => item !== '')
      .slice(0, 4);

    // 4. 按 PRD 数据模型组装
    const newPost = {
      id: 'local_' + Date.now(),
      category: category,
      title: title,
      content: content,
      tags: tags,
      authorName: CURRENT_USER.name,
      contact: contact,
      status: 'auditing', // 初始状态：审核中
      heat: 0,
      createTime: Date.now(),
      syncState: 'pending' // 仅本地使用：pending 待同步 / synced 已同步
    };

    // 5. 先存本地缓存（护城河），只保留一份未同步草稿，避免大厅重复
    let localPosts = wx.getStorageSync('local_posts') || [];
    localPosts = localPosts.filter(item => item && item.syncState === 'synced');
    localPosts.unshift(newPost);
    wx.setStorageSync('local_posts', localPosts);

    console.log('已安全保存到本地，数据为：', newPost);
    wx.showToast({ title: '已保存至本地', icon: 'success' });

    // 6. 清空输入框
    this.setData({ title: '', content: '', tagStr: '', contact: '' });

    // 7. 静默上传（模拟）：稍等一下，让「已保存至本地」的提示先显示出来
    setTimeout(() => {
      this.syncToCloud(newPost);
    }, 700);
  },

  /**
   * 模拟云端同步：本项目暂不接真实数据库
   * 成功 -> 标记 syncState: synced（贴子留在大厅，状态显示「审核中」）
   * 失败 -> 保留 syncState: pending（大厅显示红色「待同步」，下次进发布页可恢复）
   */
  syncToCloud: function (postData) {
    wx.showLoading({ title: '同步中...' });

    setTimeout(() => {
      wx.hideLoading();

      const isSuccess = Math.random() > 0.4; // 模拟 60% 成功率

      if (isSuccess) {
        let localPosts = wx.getStorageSync('local_posts') || [];
        localPosts = localPosts.map(function (item) {
          if (item && item.id === postData.id) {
            return Object.assign({}, item, { syncState: 'synced' });
          }
          return item;
        });
        wx.setStorageSync('local_posts', localPosts);
        wx.showToast({ title: '发布成功', icon: 'success' });
      } else {
        wx.showToast({ title: '网络不佳，已存草稿', icon: 'none' });
      }

      // PRD：延迟 1 秒后强制返回大厅
      setTimeout(() => {
        wx.navigateBack();
      }, 1000);

    }, 800);
  }
});
