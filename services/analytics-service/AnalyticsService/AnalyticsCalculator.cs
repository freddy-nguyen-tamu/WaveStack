namespace AnalyticsService;

public sealed record PlayEvent(string SongId, string UserId, int DurationSeconds, DateTimeOffset PlayedAt);
public sealed record TrendingSong(string SongId, int PlayCount);
public sealed record DailyReport(int TotalPlays, int UniqueListeners, int TotalListeningSeconds);
public sealed record InternalMetrics(int SongsTracked, int EventsTracked);

public sealed class AnalyticsCalculator
{
    private readonly List<PlayEvent> events = new();

    public void RecordPlay(PlayEvent playEvent)
    {
        events.Add(playEvent);
    }

    public IReadOnlyList<TrendingSong> GetTrendingSongs()
    {
        return events
            .GroupBy(item => item.SongId)
            .Select(group => new TrendingSong(group.Key, group.Count()))
            .OrderByDescending(item => item.PlayCount)
            .ToList();
    }

    public DailyReport GetDailyReport()
    {
        return new DailyReport(
            TotalPlays: events.Count,
            UniqueListeners: events.Select(item => item.UserId).Distinct().Count(),
            TotalListeningSeconds: events.Sum(item => item.DurationSeconds)
        );
    }

    public InternalMetrics GetInternalMetrics()
    {
        return new InternalMetrics(
            SongsTracked: events.Select(item => item.SongId).Distinct().Count(),
            EventsTracked: events.Count
        );
    }
}
