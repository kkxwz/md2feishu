---
title: md2feishu 功能演示
---

# md2feishu 功能演示

这是一个覆盖全部语法特性的示例文档，用下面的命令发布到飞书：

```bash
md2feishu push example/demo.md --folder <你的文件夹token>
```

## 行内样式

**加粗**、*斜体*、~~删除线~~、`行内代码`、[链接](https://open.feishu.cn)、**粗体里的[链接](https://example.com)**，以及行内公式 $e^{i\pi} + 1 = 0$。

## 列表

无序列表：

- 第一层
  - 第二层
    - 第三层

有序列表（起始编号 3）：

3. 从三开始
4. 自动连续

任务列表：

- [x] 已完成事项
- [ ] 待办事项

## 引用与 GFM 高亮块

> 普通引用：洞察死于沉默，反馈生于表达。

> [!NOTE]
> NOTE 类型高亮块（蓝色 💡）。

> [!TIP]
> TIP 类型高亮块（绿色 ✅）。

> [!WARNING]
> WARNING 类型高亮块（黄色 🚨）。

## 表格

| 功能 | 本工具 | 一般工具 |
| --- | --- | --- |
| 表格 | ✓ | 部分 |
| 数学公式 | ✓ | ✗ |
| 原位更新 | ✓ | ✗ |
| 知识库发布 | ✓ | ✗ |

## 代码块

```python
def greet(name: str) -> str:
    return f"hello, {name}"
```

```typescript
export function sum(a: number, b: number): number {
  return a + b;
}
```

```bash
echo "shell 也没问题"
```

### mermaid 流程图

默认按纯文本代码块插入；加 `--mermaid image` 自动渲染为图片（本地 mmdc 优先，其次在线渲染，失败自动回退代码块）：

```mermaid
graph TD;
    写 Markdown-->md2feishu push;
    md2feishu push-->飞书文档;
```

## 数学公式

质能方程 $E = mc^2$ 是行内公式。

下面是块级公式：

$$
\int_{-\infty}^{\infty} e^{-x^2} \, dx = \sqrt{\pi}
$$

## 图片

本地图片：

![示例图片](./assets/example.png)

远程图片也会自动下载并上传到飞书：

![飞书开放平台](https://sf3-scmcdn-cn.feishucdn.com/obj/feishu-static/lark/open/website/share-logo.png)

## 其他

分割线：

---

脚注示例[^1]。

[^1]: 这是脚注的定义内容，会追加到文档末尾。
