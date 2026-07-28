import { ExternalLinkIcon } from "lucide-react";
import TileSpriteStrip from "@/components/Placeholder/TileSpriteStrip";
import { TILE_SPRITES, type TileSprite } from "@/components/Placeholder/tileSprites";
import SettingGroup from "@/components/Settings/SettingGroup";
import SettingSection from "@/components/Settings/SettingSection";
import { Button } from "@/components/ui/button";

const SPRITE_SCALE = 2;

const PRODUCT_LINKS = [{ label: "GitHub", href: "https://github.com/HuangJinAmm/LocalFragNote" }];

const PRODUCT_POINTS = [
  "本地优先 · 所有数据均存放在本机目录，无需账号、无需联网",
  "多模态搜索 · FTS5 全文搜索 + 本地语义向量搜索 + 标签过滤",
  "AI 增强 · AI 聊天面板 + FSRS 间隔重复复习 + 本地 LLM 启动器",
];

const BirdSprite = ({ sprite }: { sprite: TileSprite }) => {
  return (
    <figure className="flex w-auto min-w-28 flex-none flex-col items-center gap-3 rounded-xl border border-border bg-muted/20 px-4 py-4 text-center">
      <TileSpriteStrip sprite={sprite} scale={SPRITE_SCALE} className="size-16" testId="about-bird-sprite" />
      <figcaption className="min-w-0">
        <h3 className="font-mono text-sm text-foreground">{sprite.name}</h3>
      </figcaption>
    </figure>
  );
};

const About = () => {
  return (
    <section className="mx-auto w-full max-w-5xl min-h-full flex flex-col justify-start items-start sm:pt-3 md:pt-6 pb-8">
      <div className="w-full">
        <div className="w-full rounded-xl border border-border bg-background px-4 py-4 text-muted-foreground">
          <SettingSection
            title="关于 破碎星球"
            description="一款参考 Memos 项目，本地优先（local-first）的 Markdown 笔记应用，基于 Tauri 2 + React 19 + Rust 构建。"
          >
            <SettingGroup>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <img className="size-12 shrink-0 select-none rounded-md" src="/logo2.png" alt="" draggable={false} />
                  <div className="min-w-0">
                    <h1 className="text-2xl font-semibold tracking-tight text-foreground">破碎星球</h1>
                    <p className="mt-1 text-sm text-muted-foreground">LocalFragNote · 本地优先的 Markdown 笔记</p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {PRODUCT_LINKS.map((link) => (
                    <Button key={link.href} asChild variant="outline" size="lg">
                      <a href={link.href} target="_blank" rel="noreferrer">
                        {link.label}
                        <ExternalLinkIcon className="size-3.5" />
                      </a>
                    </Button>
                  ))}
                </div>
              </div>
            </SettingGroup>

            <SettingGroup
              showSeparator
              title="核心特性"
              description="全文/语义搜索、附件管理、FSRS 复习、AI 聊天与局域网发现分享，所有数据均存放在用户本机目录。"
            >
              <div className="grid gap-3 sm:grid-cols-3">
                {PRODUCT_POINTS.map((item) => (
                  <div key={item} className="rounded-lg bg-muted/40 px-3 py-2 text-sm text-foreground">
                    {item}
                  </div>
                ))}
              </div>
            </SettingGroup>

            <SettingGroup showSeparator title="Birds" description="Pixel tile strips used by empty states.">
              <section aria-label="Birds" className="flex flex-row flex-wrap gap-3">
                {TILE_SPRITES.map((sprite) => (
                  <BirdSprite key={sprite.name} sprite={sprite} />
                ))}
              </section>
            </SettingGroup>
          </SettingSection>
        </div>
      </div>
    </section>
  );
};

export default About;
