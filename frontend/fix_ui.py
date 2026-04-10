import re
path = '/Users/maasir/Projects/memux/frontend/src/components/chat-interface.tsx'
with open(path, 'r') as f:
    content = f.read()

content = content.replace(
    'className="text-[15px] prose dark:prose-invert max-w-none prose-p:leading-relaxed prose-pre:p-0 prose-pre:bg-transparent prose-a:text-primary"',
    'className="text-[15px] prose dark:prose-invert max-w-none prose-p:leading-relaxed prose-pre:p-0 prose-pre:bg-transparent prose-a:text-primary prose-code:before:hidden prose-code:after:hidden"'
)

pattern = r'(                                    \{/\* Hover Actions Bar \*/\}\n                                    <div className=\{`absolute -bottom-4 lg:bottom-0.*?\n                                    </div>\n)'
match = re.search(pattern, content, re.DOTALL)
if match:
    action_bar = match.group(1)
    content = content.replace(action_bar, '')
    
    new_action_bar = action_bar.replace(
        '<div className={`absolute -bottom-4 lg:bottom-0 ${m.role === \'user\' ? \'right-4 lg:right-[calc(85%+0.5rem)]\' : \'left-4 lg:left-[calc(85%+0.5rem)]\'} flex flex-row opacity-0 group-hover:opacity-100 transition-opacity bg-background/95 border shadow-sm rounded-lg p-1 gap-1 z-10`}>',
        '<div className={`flex flex-row opacity-0 group-hover:opacity-100 transition-opacity gap-1 mt-1 ${m.role === \'user\' ? \'self-end\' : \'self-start\'} z-10`}>'
    )
    new_action_bar = new_action_bar.replace(
        'rounded-md transition-colors>',
        'rounded-full transition-colors p-2 flex items-center justify-center>'
    ).replace(
        'rounded-md transition-colors">',
        'rounded-full transition-colors flex items-center justify-center">'
    )
    
    target_str = """                                        {usedSources.length > 0 && (
                                            <div className="mt-2">
                                                <ImagePreviewGrid sources={usedSources} />
                                            </div>
                                        )}
                                    </div>"""
    
    if target_str in content:
        content = content.replace(target_str, target_str + "\n" + new_action_bar.strip("\n") + "\n")
        print("Successfully updated content.")
    else:
        print("COULD NOT FIND INSERTION TARGET")
else:
    print("COULD NOT FIND ACTION BAR")

with open(path, 'w') as f:
    f.write(content)
