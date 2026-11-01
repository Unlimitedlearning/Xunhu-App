// pages/publish/publish.js
// 发布页：校验 + 模拟上传 + 落地本地缓存，不连真实云端
// 状态流转：组件默认 status: 'auditing'，上传成功保持 auditing，上传失败强改 status: 'draft'

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
    // 离线优先：找回上次上传失败的草稿（status === 'draft'）
    const localPosts = wx.getStorageSync('local_posts') || [];
    const draft = localPosts.find(item => item && item.status === 'draft');

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

    // 4. 按 PRD 数据模型组装，状态直接默认「审核中」
    const newPost = {
      id: 'local_' + Date.now(),
      category: category,
      title: title,
      content: content,
      tags: tags,
      authorName: CURRENT_USER.name,
      contact: contact,
      status: 'auditing', // 提交即审核中
      heat: 0,
      createTime: Date.now()
    };

    // 5. 模拟上传
    this.uploadPost(newPost);
  },

  /**
   * 模拟上传：本项目暂不接真实数据库
   * 成功 -> status 保持 'auditing'，存入 local_posts（大厅显示橙色「审核中」）
   * 失败 -> status 强改为 'draft' 后再存入 local_posts（大厅显示红色「草稿」，下次进发布页可恢复）
   * 无论成功失败：清空表单 -> 延迟 1 秒返回大厅
   */
  uploadPost: function (postData) {
    wx.showLoading({ title: '发布中...' });

    setTimeout(() => {
      wx.hideLoading();

      const isSuccess = Math.random() > 0.4; // 模拟 60% 成功率
      const savedPost = Object.assign({}, postData, {
        status: isSuccess ? 'auditing' : 'draft'
      });

      // 本地缓存只保留一份草稿，避免大厅出现多条重复草稿
      let localPosts = wx.getStorageSync('local_posts') || [];
      localPosts = localPosts.filter(function (item) {
        return item && item.status !== 'draft';
      });
      localPosts.unshift(savedPost);
      wx.setStorageSync('local_posts', localPosts);

      console.log('发布结果：' + (isSuccess ? '成功' : '失败') + '，数据为：', savedPost);

      if (isSuccess) {
        wx.showToast({ title: '发布成功', icon: 'success' });
      } else {
        wx.showToast({ title: '网络不佳，已存草稿', icon: 'none' });
      }

      // 清空表单（成功失败都清）
      this.setData({
        categoryIndex: 0,
        title: '',
        content: '',
        tagStr: '',
        contact: ''
      });

      // PRD：延迟 1 秒后返回大厅
      setTimeout(() => {
        wx.navigateBack();
      }, 1000);

    }, 800);
  }
});
