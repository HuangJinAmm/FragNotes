import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import CardReview from "@/components/Review/CardReview";
import DeckDetail from "@/components/Review/DeckDetail";
import DeckList from "@/components/Review/DeckList";
import { useReviewDecks } from "@/components/Review/hooks";
import type { ReviewDeck } from "@/components/Review/types";
import MobileHeader from "@/components/MobileHeader";
import { useTranslate } from "@/utils/i18n";

const ReviewPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const t = useTranslate();
  const { decks } = useReviewDecks();
  const [selectedDeck, setSelectedDeck] = useState<ReviewDeck | null>(null);

  const deckIdParam = params.deckId;
  const isStudy = location.pathname.endsWith("/study");
  // ?regenerate=<memoUid>：笔记侧栏「重新生成」跳转而来，进入后自动重生成该笔记卡片
  const searchParams = new URLSearchParams(location.search);
  const regenerateMemoUid = searchParams.get("regenerate");
  // 来源上下文：从图谱节点 / 笔记侧栏跳转而来时，返回按钮回到来源页而非列表
  const from = searchParams.get("from");
  const fromGraphId = searchParams.get("graphId");
  const fromNodeId = searchParams.get("select");
  const fromMemoUid = searchParams.get("memoUid");
  const fromQuery =
    from === "kg" && fromGraphId
      ? `?from=kg&graphId=${fromGraphId}${fromNodeId ? `&select=${fromNodeId}` : ""}`
      : from === "memo" && fromMemoUid
        ? `?from=memo&memoUid=${fromMemoUid}`
        : "";
  const backLabel =
    from === "kg" ? t("review.back-to-graph") : from === "memo" ? t("review.back-to-memo") : undefined;

  useEffect(() => {
    if (deckIdParam) {
      const deck = decks.find((d) => d.id === Number(deckIdParam));
      if (deck) {
        setSelectedDeck(deck);
      }
    } else {
      setSelectedDeck(null);
    }
  }, [deckIdParam, decks]);

  const handleSelectDeck = (deck: ReviewDeck) => {
    navigate(`/review/${deck.id}`);
  };

  const handleBackToList = () => {
    // 有来源上下文时回到来源页（图谱节点 / 笔记详情），否则回列表
    if (from === "kg" && fromGraphId) {
      navigate(`/knowledge-graph/${fromGraphId}${fromNodeId ? `?select=${fromNodeId}` : ""}`);
    } else if (from === "memo" && fromMemoUid) {
      navigate(`/memos/${fromMemoUid}`);
    } else {
      navigate("/review");
    }
  };

  const handleStartReview = () => {
    if (selectedDeck) {
      navigate(`/review/${selectedDeck.id}/study`);
    }
  };

  const showStudy = isStudy && selectedDeck;
  const showDetail = !isStudy && deckIdParam && selectedDeck;

  return (
    <section className="@container w-full min-h-full pb-10 sm:pt-3 md:pt-6">
      <MobileHeader />
      <div className="mx-auto w-full max-w-5xl px-4 sm:px-6">
        {showStudy ? (
          <CardReview
            deckId={selectedDeck.id}
            onExit={() => navigate(`/review/${selectedDeck.id}${fromQuery}`)}
          />
        ) : showDetail ? (
          <DeckDetail
            deck={selectedDeck}
            onBack={handleBackToList}
            onStartReview={handleStartReview}
            regenerateMemoUid={regenerateMemoUid}
            backLabel={backLabel}
            backQuery={fromQuery}
          />
        ) : (
          <DeckList onSelectDeck={handleSelectDeck} />
        )}
      </div>
    </section>
  );
};

export default ReviewPage;
