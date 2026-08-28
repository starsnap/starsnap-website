import Image from 'next/image';
import ThemeToggle from './theme-toggle';

const ArrowUpRight = () => <span aria-hidden="true">↗</span>;

const StarIcon = ({ className }: { className?: string }) => (
  <Image
    alt=""
    aria-hidden="true"
    className={className}
    height={96}
    priority
    src="/icon-96.png"
    unoptimized
    width={96}
  />
);

export default function Home() {
  return (
    <>
      <a className="skip-link" href="#main-content">본문으로 건너뛰기</a>
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="StarSnap 홈">
          <StarIcon className="brand-mark" />
          <span>StarSnap</span>
        </a>
        <nav className="site-nav" aria-label="주요 메뉴">
          <a href="#services">서비스</a>
          <a href="#company">회사 소개</a>
          <a href="#contact">서비스 시작</a>
        </nav>
        <div className="header-actions">
          <ThemeToggle />
          <a className="header-cta" href="#services">
            서비스 보기 <ArrowUpRight />
          </a>
        </div>
      </header>

      <main id="main-content">
      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">
            <span className="eyebrow-dot" aria-hidden="true" />
            Everyday software, thoughtfully made
          </p>
          <h1>
            사람의 연결부터
            <br />
            <span>일의 흐름까지.</span>
          </h1>
          <p className="hero-description">
            StarSnap은 관계를 만드는 SNS와 업무를 체계화하는 ERP를 중심으로,
            일상과 비즈니스에 필요한 디지털 서비스를 만듭니다.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href="#services">
              서비스 살펴보기 <ArrowUpRight />
            </a>
            <a className="button button-secondary" href="#company">
              StarSnap 알아보기
            </a>
          </div>
        </div>

        <figure className="hero-showcase">
          <figcaption className="sr-only">
            사람을 연결하는 SNS와 업무 흐름을 정리하는 ERP를 함께 보여주는 제품 이미지
          </figcaption>
          <div className="showcase-orbit orbit-one" aria-hidden="true" />
          <div className="showcase-orbit orbit-two" aria-hidden="true" />

          <div className="product-preview preview-social" aria-hidden="true">
            <div className="preview-header">
              <span className="mini-brand">
                <StarIcon className="brand-mark brand-mark-small" />
                Social
              </span>
              <span className="preview-status">Connected</span>
            </div>
            <div className="social-story-row" aria-hidden="true">
              <span /><span /><span /><span />
            </div>
            <div className="social-post" aria-hidden="true">
              <div className="post-author"><span /><i /></div>
              <div className="post-image"><b /></div>
              <div className="post-lines"><i /><i /></div>
            </div>
          </div>

          <div className="product-preview preview-erp" aria-hidden="true">
            <div className="preview-header">
              <span className="mini-brand">ERP Workspace</span>
              <span className="preview-menu" aria-hidden="true">•••</span>
            </div>
            <p className="preview-label">업무 진행 흐름</p>
            <strong className="preview-number">In sync</strong>
            <div className="progress-track" aria-hidden="true"><span /></div>
            <div className="metric-row" aria-hidden="true">
              <span><i className="metric-yellow" />업무 계획</span><b>Ready</b>
            </div>
            <div className="metric-row" aria-hidden="true">
              <span><i className="metric-dark" />팀 협업</span><b>Aligned</b>
            </div>
          </div>
          <p className="showcase-caption">Connect people. Organize work.</p>
        </figure>
      </section>

      <section className="services-preview" id="services">
        <div className="section-heading">
          <p className="section-kicker">What we build</p>
          <h2>서로 다른 하루를 더 나은 흐름으로</h2>
        </div>
        <div className="service-grid">
          <article className="service-card service-card-dark">
            <span className="service-number">01</span>
            <div>
              <p className="service-label">SOCIAL NETWORK</p>
              <h3>관심사가 관계가 되는 곳</h3>
              <p>콘텐츠와 관심사를 중심으로 사람을 발견하고, 관계를 이어가는 소셜 서비스입니다.</p>
            </div>
            <a href="#contact" aria-label="SNS 서비스 문의하기"><ArrowUpRight /></a>
          </article>
          <article className="service-card service-card-yellow">
            <span className="service-number">02</span>
            <div>
              <p className="service-label">ERP SOLUTION</p>
              <h3>복잡한 업무를 하나의 흐름으로</h3>
              <p>흩어진 정보와 프로세스를 모아, 팀이 더 명확하게 협업하고 운영하도록 돕습니다.</p>
            </div>
            <a href="#contact" aria-label="ERP 서비스 문의하기"><ArrowUpRight /></a>
          </article>
        </div>
      </section>

      <section className="company-story" id="company">
        <div className="story-intro">
          <p className="section-kicker">About StarSnap</p>
          <h2>
            기술을 앞세우기보다,
            <br />
            더 나은 <span>경험</span>을 먼저 봅니다.
          </h2>
        </div>
        <div className="story-body">
          <p>
            사람 사이의 관계와 팀 안의 업무는 모습이 달라도 결국 좋은 흐름이
            필요합니다. StarSnap은 복잡한 문제를 이해하기 쉬운 제품으로 바꾸고,
            매일 자연스럽게 쓰이는 소프트웨어를 만듭니다.
          </p>
          <div className="story-flow" aria-label="StarSnap이 만드는 가치의 흐름">
            <span>PEOPLE</span><i aria-hidden="true" />
            <span>FLOW</span><i aria-hidden="true" />
            <span>GROWTH</span>
          </div>
        </div>
      </section>

      <section className="values-section" aria-labelledby="values-title">
        <div className="values-heading">
          <p className="section-kicker">How we work</p>
          <h2 id="values-title">우리가 제품을 만드는 기준</h2>
        </div>
        <div className="values-grid">
          <article className="value-card">
            <span className="value-index">01</span>
            <div className="value-symbol symbol-user" aria-hidden="true"><i /><i /></div>
            <h3>사용자에서 시작합니다</h3>
            <p>기능보다 사용자가 실제로 겪는 불편과 맥락을 먼저 살핍니다.</p>
          </article>
          <article className="value-card">
            <span className="value-index">02</span>
            <div className="value-symbol symbol-simple" aria-hidden="true"><i /><i /><i /></div>
            <h3>복잡함을 단순하게 만듭니다</h3>
            <p>복잡한 관계와 업무 흐름을 누구나 이해하기 쉬운 경험으로 정리합니다.</p>
          </article>
          <article className="value-card">
            <span className="value-index">03</span>
            <div className="value-symbol symbol-steady" aria-hidden="true"><i /><i /></div>
            <h3>꾸준히 믿을 수 있게 만듭니다</h3>
            <p>매일 사용하는 서비스에 필요한 안정성과 책임을 중요하게 생각합니다.</p>
          </article>
        </div>
      </section>

      <section className="contact-section" id="contact">
        <div className="contact-copy">
          <p className="section-kicker">Start a conversation</p>
          <h2>더 나은 연결과 운영,<br />대표 서비스에서 시작하세요.</h2>
        </div>
        <div className="contact-side">
          <p>SNS에서 관심사를 연결하고, ERP에서 팀의 업무 흐름을 정리해 보세요.</p>
          <div className="contact-actions">
            <a className="button contact-button" href="https://sns.starsnap.kr">
              SNS 시작하기 <ArrowUpRight />
            </a>
            <a className="button contact-button contact-button-secondary" href="https://erp.starsnap.kr">
              ERP 살펴보기 <ArrowUpRight />
            </a>
          </div>
        </div>
        <div className="contact-decoration" aria-hidden="true">
          <span /><span /><span />
        </div>
      </section>

      </main>

      <footer className="site-footer">
        <a className="wordmark footer-wordmark" href="#top" aria-label="StarSnap 홈으로 이동">
          <StarIcon className="brand-mark" />
          <span>StarSnap</span>
        </a>
        <p>SNS · ERP · Digital Products</p>
        <p><a href="https://starsnap.kr">starsnap.kr</a> · © 2026 StarSnap</p>
      </footer>
    </>
  );
}
