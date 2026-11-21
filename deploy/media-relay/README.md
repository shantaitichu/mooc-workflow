# 数字人动作素材中转

服务器接收 Dreamactor 当前任务所需的人物参考图和动作模板。工作台上传时使用独立令牌。模型使用一小时有效的签名链接读取，服务器清理超过 24 小时的临时文件。

## 在服务器上安装

适用于已有 Nginx HTTPS 站点、Python 3 和 systemd 的 Linux 服务器。将部署包上传到服务器并解压，在解压目录以 root 身份运行下面的命令。将地址替换为站点证书和 Nginx 配置中使用的 IP 或域名。

```sh
python3 install.py --host relay.example.org
```

安装器为该 HTTPS 站点添加 `/mooc-media/`，中转程序仅在 `127.0.0.1:18789` 监听。远端令牌保存在 `/etc/mooc-media-relay.env`。要通过腾讯云网页终端操作，可从云控制台进入对应实例，并使用该实例的终端文件上传功能传入部署包。

## 连接 Windows 工作台

1. 在本机项目根目录的 `.env` 中设置 `MEDIA_RELAY_URL=https://relay.example.org/mooc-media/`，并将 `MEDIA_RELAY_TOKEN` 设为远端同名变量的值。通过自己的管理会话复制令牌，勿把它发到聊天中。
2. 关闭旧的本地后台，重新运行「启动客户端和本地后台.bat」。
3. 在「动作素材」中打开已抠像的视频，检查服务状态，再选段生成。公网健康地址为 `https://relay.example.org/mooc-media/healthz`，正常应返回 HTTP 200。

中转与云模型分别运行。安装中转及检查健康地址不会提交模型任务。真实生成按工作台显示的预算提交。
