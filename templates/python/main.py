"""{{title}} — a Helm plugin. Run `helm plugin dev .` to try it with hot reload."""
from helm_plugin import Plugin, ui

plugin = Plugin()


@plugin.on_activate
def activate(ctx):
    ctx.log.info(f"{ctx.plugin['id']} started (isolation: {ctx.isolation})")


@plugin.tool("hello")
def hello(input, ctx):
    return f"{ctx.config.get('greeting', 'Hello')}, {input['name']}!"


@plugin.tool("word_count")
def word_count(input, ctx):
    # ctx.fs is checked against the fs.read grant; paths outside the workspace are refused.
    text = ctx.fs.read_text(input["path"])
    return f"{input['path']} has {len(text.split())} words"


@plugin.command("about")
def about(args, ctx):
    return ui.stack(ui.heading(ctx.plugin["id"]), ui.key_value({"version": ctx.plugin["version"], "workspace": ctx.workspace, "isolation": ctx.isolation}))


if __name__ == "__main__":
    plugin.run()
