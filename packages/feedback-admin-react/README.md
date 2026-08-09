# @feedback/admin-react

Feedback Service v1だけを利用する独立管理UIです。Web GISのAPI、DB、route、OIDC audienceには依存しません。
session/scope/perspective、thread/evidence/deep link、manifest、retention、membership、notification delivery、
server-side CSV/XLSX exportを管理できます。

```tsx
import { FeedbackAdminConsole } from "@feedback/admin-react";
import "@feedback/admin-react/styles.css";

<FeedbackAdminConsole
  transport={transport}
  applicationKey="consumer-app"
  environmentKey="production"
  externalWorkspaceKey="workspace-1"
/>;
```

正式配布先が承認されるまでは `private: true` を維持し、repository内のAdmin Consoleからworkspace参照します。
