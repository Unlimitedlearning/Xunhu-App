// utils/mockData.js
// 寻呼 (Xunhu) 本地假数据
// 字段严格遵循 PRD「四、核心数据模型」：
//   posts        -> id / category / title / content / tags / authorName / contact / status / heat / createTime
//   applications -> id / postId / applicantId / applicantName / receiverId / status / createTime
// 说明：本文件仅提供数据，不含任何页面逻辑。

// 固定基准时间，保证每次运行 createTime 稳定可复现
const BASE_TIME = 1735660800000; // 2025-01-01 00:00:00
const HOUR = 60 * 60 * 1000;

/**
 * 帖子假数据（对应 posts 集合）
 * category 枚举：team 组队 / resume 自荐 / partner 搭子
 * status   枚举：auditing 审核中 / active 寻呼中 / ended 已结束
 */
const postList = [
  {
    id: "1852052739",
    category: "team",
    title: "挑战杯项目招募前端开发",
    content: "已有人机交互和商业策划，急缺一名会用 Vue 的前端大佬，目标省赛。",
    tags: ["前端", "Vue", "挑战杯"],
    authorName: "张同学",
    contact: "wxid_zhang_xh",
    status: "auditing",
    heat: 5,
    createTime: BASE_TIME - 2 * HOUR
  },
  {
    id: "4562418363",
    category: "resume",
    title: "大一计科，熟悉Godot，求带",
    content: "暑假用Godot做过小游戏，想找大创队伍被带飞。",
    tags: ["Godot", "C#", "游戏开发"],
    authorName: "李同学",
    contact: "wxid_li_godot",
    status: "ended",
    heat: 9,
    createTime: BASE_TIME - 26 * HOUR
  },
  {
    id: "7392015486",
    category: "partner",
    title: "寻晚上去图书馆复习四级的搭子",
    content: "一个人容易玩手机，找个搭子互相监督，晚上七点到十点，图书馆三楼自习区。",
    tags: ["四级", "学习"],
    authorName: "王同学",
    contact: "wxid_wang_lib",
    status: "active",
    heat: 3,
    createTime: BASE_TIME - 5 * HOUR
  },
  {
    id: "6204851739",
    category: "team",
    title: "大创项目招后端同学",
    content: "做校园二手信息聚合，已有产品与前端，缺一位熟悉 Node.js 或云开发的后端同学，一起冲校级立项。",
    tags: ["大创", "Node.js", "云开发"],
    authorName: "陈同学",
    contact: "wxid_chen_backend",
    status: "active",
    heat: 7,
    createTime: BASE_TIME - 9 * HOUR
  },
  {
    id: "3187640925",
    category: "resume",
    title: "会剪视频，想找宣传组",
    content: "熟练使用剪映和 Pr，做过社团招新宣传片，希望加入有比赛或活动宣传需求的队伍。",
    tags: ["剪辑", "Pr", "宣传"],
    authorName: "林同学",
    contact: "wxid_lin_video",
    status: "active",
    heat: 2,
    createTime: BASE_TIME - 14 * HOUR
  },
  {
    id: "9021837465",
    category: "partner",
    title: "周末约羽毛球搭子",
    content: "水平入门，主要想活动一下，周六下午体育馆，缺一到两人凑双打。",
    tags: ["羽毛球", "运动"],
    authorName: "黄同学",
    contact: "wxid_huang_badm",
    status: "auditing",
    heat: 0,
    createTime: BASE_TIME - 1 * HOUR
  }
];

/**
 * 申请流转假数据（对应 applications 集合）
 * status 枚举：pending 待处理 / accepted 已同意 / rejected 已拒绝
 * 关联关系：postId -> postList[].id，receiverId 为对应帖子的发帖人
 */
const mockApplications = [
  {
    id: "app_1001",
    postId: "1852052739",
    applicantId: "openid_mock_li",
    applicantName: "李同学",
    receiverId: "openid_mock_zhang",
    status: "pending",
    createTime: BASE_TIME - 1 * HOUR
  },
  {
    id: "app_1002",
    postId: "6204851739",
    applicantId: "openid_mock_lin",
    applicantName: "林同学",
    receiverId: "openid_mock_chen",
    status: "accepted",
    createTime: BASE_TIME - 6 * HOUR
  },
  {
    id: "app_1003",
    postId: "7392015486",
    applicantId: "openid_mock_huang",
    applicantName: "黄同学",
    receiverId: "openid_mock_wang",
    status: "rejected",
    createTime: BASE_TIME - 3 * HOUR
  },
  {
    id: "app_1004",
    postId: "3187640925",
    applicantId: "openid_mock_zhang",
    applicantName: "张同学",
    receiverId: "openid_mock_lin",
    status: "pending",
    createTime: BASE_TIME - 30 * 60 * 1000
  }
];

module.exports = {
  postList,
  mockApplications
};
