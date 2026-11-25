import { useEffect } from 'react';

// When the URL's topic is not already the discussion's slug (an old slug, or a
// title typed by hand), ask the server where the discussion lives now and
// replace the URL with it. A deleted discussion sends the visitor home.
export function useCanonicalRoute(topic, discussionSlug, navigate) {
    useEffect(() => {
        if (topic === discussionSlug) return undefined;

        let cancelled = false;
        const search = typeof window !== 'undefined' ? window.location.search : '';
        const fallback = `/discussion/${discussionSlug}${search}`;

        const resolveRoute = async () => {
            try {
                const response = await fetch(`/api/discussions/resolve/${encodeURIComponent(topic)}`);
                if (response.status === 410) {
                    if (!cancelled) {
                        navigate('/', { replace: true, state: { discussionDeleted: true } });
                    }
                    return;
                }
                if (response.ok) {
                    const data = await response.json();
                    if (!cancelled && data?.slug) {
                        navigate(`/discussion/${data.slug}${search}`, { replace: true });
                        return;
                    }
                }
            } catch (error) {
                console.warn('Failed to resolve discussion route:', error);
            }

            if (!cancelled) {
                navigate(fallback, { replace: true });
            }
        };

        resolveRoute();
        return () => {
            cancelled = true;
        };
    }, [topic, discussionSlug, navigate]);
}
