On window focus, call context.set_context(...).

After every tool run, call memory.write(event, scope="this_task").

Before planning, call memory.retrieve({scope:["this_task","project"], budget:12}); insert snippets into the Context section.

If tokens exceed limit, compress snippets via packer or lower k.

When something becomes broadly useful, call memory.promote(to_scope="project").

Log each step with eval.log.