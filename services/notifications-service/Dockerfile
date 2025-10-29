FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src

COPY ["src/NotificationsService/NotificationsService.csproj", "src/NotificationsService/"]
RUN dotnet restore "src/NotificationsService/NotificationsService.csproj"

COPY . .
WORKDIR "/src/src/NotificationsService"
RUN dotnet build "NotificationsService.csproj" -c Release -o /app/build
RUN dotnet publish "NotificationsService.csproj" -c Release -o /app/publish /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
EXPOSE 8080

COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "NotificationsService.dll"]


