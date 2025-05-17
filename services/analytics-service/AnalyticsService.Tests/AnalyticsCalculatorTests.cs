using AnalyticsService;

namespace AnalyticsService.Tests;

public sealed class AnalyticsCalculatorTests
{
    [Fact]
    public void GetTrendingSongsOrdersByPlayCount()
    {
        var calculator = new AnalyticsCalculator();
        calculator.RecordPlay(new PlayEvent("song-1", "user-1", 120, DateTimeOffset.UtcNow));
        calculator.RecordPlay(new PlayEvent("song-2", "user-1", 90, DateTimeOffset.UtcNow));
        calculator.RecordPlay(new PlayEvent("song-1", "user-2", 140, DateTimeOffset.UtcNow));

        var trending = calculator.GetTrendingSongs();

        Assert.Equal("song-1", trending[0].SongId);
        Assert.Equal(2, trending[0].PlayCount);
    }
}
