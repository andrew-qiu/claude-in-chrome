// host 连接状态（host-link 写，tools/background 读——避免模块间循环引用）

export const connState = {
  connected: false, // native messaging port 是否在连
};
