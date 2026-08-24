# StarSnap Company Design System

이 사이트는 별도의 시각 체계를 만들지 않고 StarSnap 제품군의 공식 디자인 시스템을 사용합니다.

## Source of truth

- 원본 토큰: `starsnap-main/starsnap-web/design-system/tokens.json`
- 회사 사이트 배포용 복사본: `app/starsnap-tokens.css`
- 공통 아이콘: `starsnap-main/starsnap-web/src/components/icons/index.tsx`의 `StarIcon`
- 공통 헤더·카드 관례: `AppHeader`, `SnapCard`, `CategoryChips`, `Tabs`

`app/starsnap-tokens.css`는 공식 생성 CSS와 동일하게 유지합니다. 색상, 폰트, 간격, 반경, 그림자, 모션 값을 이 문서에서 별도로 재정의하지 않습니다.

## Company site rules

- Pretendard를 기본 글꼴로 사용합니다.
- 대표 행동은 `--ss-brand` 배경과 `--ss-on-brand` 텍스트를 사용합니다.
- 기본 컨트롤 높이는 44px, 컨트롤 반경은 14px, 카드 반경은 20px입니다.
- 카드는 surface, 1px border, shadow-sm을 기본으로 하고 상호작용 시 최대 2px 이동과 shadow-md를 사용합니다.
- 헤더는 64px, 반투명 surface, 하단 border, shadow-sm, backdrop blur를 사용합니다.
- 모든 포커스 표시는 3px `--ss-focus-ring`과 2px offset을 사용합니다.
- 다크 테마는 `html.dark` 의미 토큰을 그대로 따릅니다.
